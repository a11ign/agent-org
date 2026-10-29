// no-token: herdr -- every call here is a recording runner or a stub `herdr` put first on PATH; the real herdr is never reached
/**
 * A11-379: THE ASYNC FORMS OF HERDR'S CALLS ANSWER AS THE SYNCHRONOUS ONES DO, AND DO NOT HOLD THE LOOP.
 *
 * `herdrRunAsync` runs the real program through `realExecAsync` (a stub `herdr` on PATH stands for it). `readAgentsAsync`, `openPaneAsync` and `closedNoteAsync` are held to their synchronous forms over the
 * same scripted herdr: the same calls, in the same order, and the same answer, for a success and for each refusal.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { closedNote, closedNoteAsync, herdrRun, herdrRunAsync, openPane, openPaneAsync, readAgents, readAgentsAsync } from "./herdr-agents.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.(); });

/** A directory holding a `herdr` that runs `body` (a shell script), first on PATH until the test ends; its `log` file collects each call's arguments. */
function stubHerdr(body: string): { log: string; calls: () => string[] } {
  const dir = tmpDir("herdr-async-");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "herdr"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${body}\n`);
  chmodSync(join(dir, "herdr"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before ?? ""}`;
  cleanups.push(() => { process.env.PATH = before; });
  return { log, calls: () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } } };
}

/** What `fn` writes to this process's stderr while it runs. */
async function stderrOf(fn: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await fn().catch(() => undefined); } finally { process.stderr.write = original; }
  return written.join("");
}

test("herdrRunAsync resolves what herdr printed, called with the arguments it was given", async () => {
  const herdr = stubHerdr(`printf '{"result":{}}'`);
  assert.equal(await herdrRunAsync(["--session", "org", "workspace", "list"]), '{"result":{}}');
  assert.deepEqual(herdr.calls(), ["--session org workspace list"]);
});

test("herdrRunAsync rejects as herdrRun throws: status, stdout and stderr on the error, and a refusal is written to stderr", async () => {
  stubHerdr(`printf 'out' ; printf '{"error":{"code":"bad_flag"}}\\n' >&2; exit 3`);
  const sync = (() => { try { herdrRun(["x"]); } catch (err) { return err as any; } })();
  let thrown: any;
  const written = await stderrOf(() => herdrRunAsync(["x"]).catch((err) => { thrown = err; throw err; }));
  assert.equal(thrown.status, 3);
  assert.equal(thrown.stdout, "out");
  assert.equal(thrown.stderr, sync.stderr);
  assert.match(thrown.message, /^Command failed: herdr x\n/);
  assert.equal(written, sync.stderr);
});

test("herdrRunAsync keeps the answers of an ended seat out of stderr, as herdrRun does", async () => {
  stubHerdr(`printf '{"error":{"code":"agent_not_found"}}\\n' >&2; exit 1`);
  let thrown: any;
  const written = await stderrOf(() => herdrRunAsync(["agent", "get", "worker-1"]).catch((err) => { thrown = err; throw err; }));
  assert.equal(written, "");
  assert.match(thrown.stderr, /agent_not_found/);
});

test("herdrRunAsync rejects with no status when herdr cannot start", async () => {
  const dir = tmpDir("herdr-none-");
  const before = process.env.PATH;
  process.env.PATH = dir;
  cleanups.push(() => { process.env.PATH = before; });
  await assert.rejects(herdrRunAsync(["x"]), (err: any) => err.status === null && err.stderr === undefined && /^spawn herdr ENOENT/.test(err.message));
});

test("herdrRunAsync rejects with no status when herdr outlives its bound", async () => {
  stubHerdr("sleep 5");
  await assert.rejects(herdrRunAsync(["x"], 100), (err: any) => err.status === null && err.stderr === undefined && /^spawn herdr ETIMEDOUT/.test(err.message));
});

test("A11-379: the event loop goes on while herdr answers", async () => {
  stubHerdr("sleep 0.4");
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try { await herdrRunAsync(["x"]); } finally { clearInterval(timer); }
  assert.ok(ticks >= 5, `the loop ran ${ticks} times in the 400 ms herdr took`);
});

/** One scripted herdr: `answer` is what a call gets (a string, or an error to throw). Both runners record the calls they make. */
function scripted(answer: (args: string[]) => string) {
  const calls: string[][] = [];
  const sync = (args: string[]): string => { calls.push(args); return answer(args); };
  const later = async (args: string[]): Promise<string> => { calls.push(args); return answer(args); };
  return { calls, sync, later };
}

const PANE_GONE = Object.assign(new Error("Command failed: herdr pane read"), { stderr: '{"error":{"code":"pane_not_found"}}\n' });

const listing = (...workspaces: { label: string; status: string; id?: string }[]) => JSON.stringify({ result: { workspaces: workspaces.map((w) => ({ label: w.label, agent_status: w.status, ...(w.id === undefined ? {} : { workspace_id: w.id }) })) } });

/** The org's listing: the standing panes and `others`, with the panes in `gone` refused by `pane read` and those in `broken` failing for another reason. */
function herdrOf(others: { label: string; status: string; id: string }[], { gone = [] as string[], broken = [] as string[] } = {}) {
  return (args: string[]): string => {
    if (args[2] === "workspace" && args[3] === "list") return listing({ label: "ceo", status: "idle", id: "w1" }, { label: "orchestrator", status: "idle", id: "w2" }, ...others);
    if (args[2] === "pane" && args[3] === "read") {
      if (gone.includes(args[4])) throw PANE_GONE;
      if (broken.includes(args[4])) throw new Error("herdr did not answer");
      return "a screen";
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
}

const READ_CASES: [string, (args: string[]) => string][] = [
  ["a listing of working agents", herdrOf([{ label: "worker-1", status: "working", id: "w3" }])],
  ["an org with no workspaces", () => listing()],
  ["a pane herdr no longer has", herdrOf([{ label: "worker-2", status: "unknown", id: "w4" }, { label: "worker-3", status: "unknown", id: "w5" }], { gone: ["w4:p1"] })],
  ["a pane that cannot be read for another reason", herdrOf([{ label: "worker-2", status: "unknown", id: "w4" }], { broken: ["w4:p1"] })],
  ["a workspace with no id", () => listing({ label: "worker-9", status: "unknown" })],
  ["herdr not answering", () => { throw new Error("no herdr"); }],
  ["an answer that is not JSON", () => "not json"],
  ["an answer with no workspaces", () => '{"result":{}}'],
];

for (const [name, answer] of READ_CASES) {
  test(`readAgentsAsync answers as readAgents does for ${name}, with the same calls in the same order`, async () => {
    const sync = scripted(answer);
    const later = scripted(answer);
    const saidSync: string[] = [];
    const saidAsync: string[] = [];
    const expected = readAgents(sync.sync, { say: (line) => saidSync.push(line) });
    const actual = await readAgentsAsync(later.later, { say: (line) => saidAsync.push(line) });
    assert.deepEqual(actual, expected);
    assert.deepEqual(later.calls, sync.calls);
    assert.deepEqual(saidAsync, saidSync);
  });
}

test("readAgentsAsync keeps null (herdr did not answer) apart from [] (the org has no workspaces)", async () => {
  assert.equal(await readAgentsAsync(async () => { throw new Error("no herdr"); }), null);
  assert.deepEqual(await readAgentsAsync(async () => listing()), []);
});

test("readAgentsAsync marks a pane herdr no longer has as paneless, and only then", async () => {
  const run = herdrOf([{ label: "worker-2", status: "unknown", id: "w4" }, { label: "worker-3", status: "unknown", id: "w5" }], { gone: ["w4:p1"], broken: ["w5:p1"] });
  const agents = await readAgentsAsync(async (args) => run(args), { say: () => {} });
  assert.equal(agents?.find((a) => a.label === "worker-2")?.paneless, true);
  assert.equal(agents?.find((a) => a.label === "worker-3")?.paneless, undefined);
});

test("readAgentsAsync says the paneless line once per change in the set, through one sink", async () => {
  const run = async (args: string[]) => herdrOf([{ label: "worker-2", status: "unknown", id: "w4" }], { gone: ["w4:p1"] })(args);
  const said: string[] = [];
  const say = (line: string) => said.push(line);
  await readAgentsAsync(run, { say });
  await readAgentsAsync(run, { say });
  assert.deepEqual(said, ["treated 1 listed agents with no pane as ended: worker-2"]);
});

const OPEN_ANSWER = (workspace: string | undefined, pane: string | undefined) => JSON.stringify({ result: { ...(pane === undefined ? {} : { root_pane: { pane_id: pane } }), ...(workspace === undefined ? {} : { workspace: { workspace_id: workspace } }) } });

const OPEN_CASES: [string, (args: string[]) => string][] = [
  ["a pane opened", () => OPEN_ANSWER("w7", "w7:p1")],
  ["herdr refusing to create", () => { throw Object.assign(new Error("Command failed"), { stderr: "no room\n" }); }],
  ["a workspace with no pane id, which is closed", (args) => (args.includes("close") ? '{"type":"ok"}' : OPEN_ANSWER("w7", undefined))],
  ["a workspace with no pane id that will not close", (args) => { if (args.includes("close")) throw new Error("close refused"); return OPEN_ANSWER("w7", undefined); }],
  ["an answer naming neither", (args) => (args.includes("close") ? "{}" : OPEN_ANSWER(undefined, undefined))],
];

for (const [name, answer] of OPEN_CASES) {
  test(`openPaneAsync answers as openPane does for ${name}, with the same calls`, async () => {
    const sync = scripted(answer);
    const later = scripted(answer);
    const env = { A11Y_REVIEWER_SESSION: "reviewer-1" };
    const expected = openPane(sync.sync, "reviewer-1", env, "/tree", { session: "tickets" });
    const actual = await openPaneAsync(later.later, "reviewer-1", env, "/tree", { session: "tickets" });
    assert.deepEqual(actual, expected);
    assert.deepEqual(later.calls, sync.calls);
  });
}

for (const [name, answer] of [["a workspace that closes", () => "{}"], ["a workspace that will not close", () => { throw new Error("busy"); }]] as [string, () => string][]) {
  test(`closedNoteAsync words ${name} as closedNote does`, async () => {
    const sync = scripted(answer);
    const later = scripted(answer);
    assert.equal(await closedNoteAsync(later.later, "w7", { session: "tickets" }), closedNote(sync.sync, "w7", { session: "tickets" }));
    assert.deepEqual(later.calls, sync.calls);
  });
}
