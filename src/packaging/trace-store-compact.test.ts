// agent-org#475: the trace store keeps ONE line per event id, so a sum over its lines is a sum over its events. Fixtures only: a scratch store beside a scratch state. Nothing here
// reads `~/.cache/a11ign`, GitHub or a transcript.
// no-token: none -- no test here calls `gh`; the CLI cases run `trace.ts compact-store` against a scratch store
import assert from "node:assert/strict";
import { appendFileSync, closeSync, cpSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { stateFileFor, loadState, emptyState, saveState, STATE_VERSION } from "../trace/ingest-state.ts";
import { appendToStore, compactStore, openStore, readStore, rewriteStore } from "../trace/store.ts";
import type { RewriteStage, TraceEvent } from "../trace/store.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const event = (id: string, extra: Record<string, unknown> = {}, kind = "turn") => ({ id, kind, source: "transcript", at: 1, session: "s", row: null, pr: null, repo: null, ...extra }) as unknown as TraceEvent;
const line = (e: TraceEvent) => `${JSON.stringify(e)}\n`;
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter((text) => text !== "");
const idsOnDisk = (path: string) => lines(path).map((text) => JSON.parse(text).id as string);
const write = (path: string, events: TraceEvent[]) => writeFileSync(path, events.map(line).join(""));

/** A scratch store path, its directory holding nothing else, so a leftover temp file or backup shows. */
const scratch = () => {
  const dir = tmpDir("trace-store-compact-");
  return { dir, store: join(dir, "events.ndjson") };
};

// The legacy file: an append-only log, a corrected copy appended after the stored one.
const A = event("a", { tokens: 1 });
const B = event("b", { tokens: 2 });
const C = event("c", { tokens: 3 }, "wake");
const A2 = event("a", { tokens: 10 });

test("appending a differing copy of an id leaves ONE line for that id on disk, and readStore returns the same events as the log it replaces", () => {
  const { dir, store } = scratch();
  write(store, [A, B, C]);
  const oracle = join(dir, "oracle.ndjson"); // what the append-only log gave: the copy appended, readStore taking the last of each id
  write(oracle, [A, B, C, A2]);
  assert.deepEqual(idsOnDisk(oracle), ["a", "b", "c", "a"], "positive control: the log keeps the superseded line, which is the defect");
  const open = openStore(store);
  assert.deepEqual(appendToStore(open, [A2]), { added: 0, superseded: 1, skipped: 0 });
  assert.deepEqual(idsOnDisk(store), ["b", "c", "a"], "each id once, `a` at the position of its last copy");
  assert.deepEqual(readStore(store), readStore(oracle));
  assert.deepEqual(readStore(store).map((e) => (e as any).tokens), [2, 3, 10]);
  assert.deepEqual(readdirSync(dir).sort(), ["events.ndjson", "oracle.ndjson"], "no temp file is left");
});

test("negative control: appending only new ids leaves the earlier lines byte-for-byte as they were, and the file is not replaced", () => {
  const { store } = scratch();
  write(store, [A, B]);
  const before = readFileSync(store);
  const inode = statSync(store).ino;
  const open = openStore(store);
  assert.deepEqual(appendToStore(open, [C, B]), { added: 1, superseded: 0, skipped: 1 });
  const after = readFileSync(store);
  assert.ok(after.subarray(0, before.length).equals(before), "the earlier bytes are unchanged");
  assert.equal(after.subarray(before.length).toString("utf8"), line(C));
  assert.equal(statSync(store).ino, inode, "an append, not a rewrite: the same file");
});

test("a store already holding an id twice has it once after the first superseding append", () => {
  const { store } = scratch();
  write(store, [A, B, A2, C]);
  assert.deepEqual(idsOnDisk(store), ["a", "b", "a", "c"]);
  const open = openStore(store);
  appendToStore(open, [event("b", { tokens: 20 })]);
  assert.deepEqual(idsOnDisk(store), ["a", "c", "b"], "the old duplicate of `a` went with the rewrite, `a` kept its LAST copy's place");
  assert.equal((readStore(store)[0] as any).tokens, 10);
});

/** A second writer as the receiver is: `appendFileSync` of one line, at the stage of the rewrite named. */
const RECEIVER = event("from-receiver", { tokens: 99 }, "api_request");

for (const stage of ["scanned", "written"] as RewriteStage[]) {
  test(`a line appended by a second writer while a rewrite runs (after it ${stage === "scanned" ? "read the file" : "wrote the temp file"}) is still in the file afterwards, once`, () => {
    const { dir, store } = scratch();
    write(store, [A, B, A2]);
    let fired = 0;
    const count = rewriteStore(store, { during: (at) => {
      if (at !== stage) return;
      fired += 1;
      appendFileSync(store, line(RECEIVER));
    } });
    assert.equal(fired, 1, "positive control: the writer did run during the rewrite");
    assert.deepEqual([count.removed, count.byKind], [1, { turn: 1 }]);
    assert.deepEqual(idsOnDisk(store), ["b", "a", "from-receiver"]);
    assert.deepEqual(readdirSync(dir), ["events.ndjson"]);
  });
}

test("a line a second writer appended to the OLD file after the rename (it had the file open) is carried to the new one", () => {
  const { store } = scratch();
  write(store, [A, A2, B]);
  const receiver = openSync(store, "a"); // the receiver's `appendFileSync` opened the file before the rename and writes after it
  try {
    rewriteStore(store, { during: (at) => {
      if (at === "renamed") writeSync(receiver, line(RECEIVER));
    } });
  } finally {
    closeSync(receiver);
  }
  assert.deepEqual(idsOnDisk(store), ["a", "b", "from-receiver"]);
});

test("a line the second writer is still writing (no newline yet) is not copied half: the rewrite waits for its end", async () => {
  const { store } = scratch();
  write(store, [A, A2]);
  const whole = line(RECEIVER);
  const half = Math.floor(whole.length / 2);
  let writer: ReturnType<typeof spawn> | undefined;
  const rewritten = rewriteStore(store, { during: (at) => {
    if (at !== "scanned") return;
    appendFileSync(store, whole.slice(0, half));
    // the rewrite blocks this thread while it waits, so the rest of the line comes from another process, as the receiver's would
    writer = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").appendFileSync(process.argv[1], process.argv[2]), 100)`, store, whole.slice(half)]);
  } });
  assert.ok(writer, "positive control: the half line was written during the rewrite");
  await once(writer, "exit");
  assert.equal(rewritten.removed, 1);
  assert.deepEqual(idsOnDisk(store), ["a", "from-receiver"], "the line is whole");
});

test("a rewrite that finds the file replaced under it by another rewrite starts again from the new file, and loses nothing of it", () => {
  const { store } = scratch();
  write(store, [A, B, A2]);
  let replaced = false;
  const count = rewriteStore(store, { during: (at) => {
    if (at !== "written" || replaced) return;
    replaced = true;
    rewriteStore(store); // the other rewriter: it finishes first, and its file is another inode
    appendFileSync(store, line(event("late", {}, "wake")));
  } });
  assert.ok(replaced);
  assert.equal(count.distinct, 3);
  assert.deepEqual(idsOnDisk(store), ["b", "a", "late"]);
});

test("a store whose last line is not a line (no newline, never completed) is refused and left as it was", () => {
  const { dir, store } = scratch();
  writeFileSync(store, `${line(A)}${line(A2)}{"id":"half`);
  const before = readFileSync(store);
  assert.throws(() => rewriteStore(store), /ends in a line with no newline/);
  assert.ok(readFileSync(store).equals(before));
  assert.deepEqual(readdirSync(dir), ["events.ndjson"]);
});

// ---- compact-store ----

const ENV_HOST = "AGENT_ORG_HOST";

/** What `trace.ts` refuses to import without: a declared project, which the caller's own wins over (`tmp-fixtures-are-removed.test.ts` does the same). */
function hostEnv(dir: string): NodeJS.ProcessEnv {
  if (process.env[ENV_HOST]) return process.env;
  const project = join(dir, "project");
  cpSync(join(ROOT, "src/packaging/fixtures/org-health/project"), project, { recursive: true });
  const hostFile = join(dir, "host.json");
  writeFileSync(hostFile, JSON.stringify({ schema: 1, home: dir, binDir: join(dir, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: project }],
    gh: { workers: join(dir, "workers"), leads: join(dir, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
  return { ...process.env, [ENV_HOST]: hostFile };
}

/** `node src/trace/trace.ts compact-store ...`, as the host runs it. */
function cli(dir: string, ...args: string[]) {
  const run = spawnSync(process.execPath, ["src/trace/trace.ts", "compact-store", ...args], { cwd: ROOT, env: hostEnv(dir), encoding: "utf8" });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

const DIRTY = [event("x", { n: 1 }), event("y", { n: 1 }, "wake"), event("x", { n: 2 }), event("z", { n: 1 }, "gh_call"), event("y", { n: 2 }, "wake"), event("x", { n: 3 })];
// x three times, y twice, z once: 6 lines, 3 ids, 3 removed (two turns, one wake)

test("compact-store --dry-run changes nothing on disk and prints the lines, the distinct ids, the removed count and the count by kind", () => {
  const { dir, store } = scratch();
  write(store, DIRTY);
  writeFileSync(stateFileFor(store), JSON.stringify({ ...emptyState({ now: 0, since: 0 }), storeBytes: statSync(store).size }));
  const bytes = readFileSync(store);
  const state = readFileSync(stateFileFor(store));
  const run = cli(dir, "--store", store, "--dry-run");
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /before: 6 lines, 3 distinct ids, 3 lines to remove \(by kind: turn 2, wake 1\)/);
  assert.match(run.out, /dry run: 3 lines would be removed; nothing was written/);
  assert.ok(readFileSync(store).equals(bytes), "the store's bytes are equal before and after");
  assert.ok(readFileSync(stateFileFor(store)).equals(state), "so is the state");
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes("bak") || name.endsWith(".tmp")), [], "no backup, no temp file");
});

test("compact-store on three copies of one id and two of another leaves lines equal to distinct ids, writes the backup first, and keeps the state valid", () => {
  const { dir, store } = scratch();
  write(store, DIRTY);
  const original = readFileSync(store);
  const events = readStore(store);
  saveState(stateFileFor(store), { ...emptyState({ now: 5, since: 0 }), storeBytes: original.length });
  assert.equal(loadState({ statePath: stateFileFor(store), storePath: store, now: 5, since: 0 }).coldStart, null, "positive control: the state is trusted before");
  const run = cli(dir, "--store", store);
  assert.equal(run.status, 0, run.err);
  const backup = `${store}.bak-${new Date().toISOString().slice(0, 10)}`;
  assert.ok(existsSync(backup), "the backup is named for the store and the UTC date");
  assert.ok(readFileSync(backup).equals(original), "and holds the bytes the store had before the rewrite");
  assert.equal(lines(store).length, 3);
  assert.deepEqual(idsOnDisk(store), ["z", "y", "x"], "each id once, at the position of its last copy");
  assert.deepEqual(readStore(store), events, "readStore returns the same events in the same order");
  assert.match(run.out, /before: 6 lines, 3 distinct ids, 3 lines to remove/);
  assert.match(run.out, /after: 3 lines, 3 distinct ids, 0 lines removable/);
  assert.ok(run.out.indexOf("backup:") < run.out.indexOf("after:"));
  const state = loadState({ statePath: stateFileFor(store), storePath: store, now: 5, since: 0 });
  assert.equal(state.coldStart, null, "the state recorded the old size, and the smaller store is still trusted");
  assert.equal(state.state.storeBytes, statSync(store).size);
  assert.equal(state.state.version, STATE_VERSION);
});

test("compact-store on a store with nothing to remove writes no backup and does not rewrite", () => {
  const { dir, store } = scratch();
  write(store, [A, B]);
  const inode = statSync(store).ino;
  const run = cli(dir, "--store", store);
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /nothing to remove/);
  assert.equal(statSync(store).ino, inode);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes("bak")), []);
});

test("compact-store refuses to overwrite a backup of the same day, and leaves the store as it was", () => {
  const { dir, store } = scratch();
  write(store, DIRTY);
  const original = readFileSync(store);
  const earlier = `${store}.bak-${new Date().toISOString().slice(0, 10)}`;
  writeFileSync(earlier, "an earlier backup");
  const run = cli(dir, "--store", store);
  assert.notEqual(run.status, 0);
  assert.match(run.err, /EEXIST/);
  assert.ok(readFileSync(store).equals(original));
  assert.equal(readFileSync(earlier, "utf8"), "an earlier backup");
});

test("compact-store refuses an argument it does not know: a misspelt --dry-run must not rewrite the store", () => {
  const { dir, store } = scratch();
  write(store, DIRTY);
  const original = readFileSync(store);
  const run = cli(dir, "--store", store, "--dryrun");
  assert.notEqual(run.status, 0);
  assert.match(run.err, /unknown argument/);
  assert.ok(readFileSync(store).equals(original));
});

test("compactStore says so when there is no store", () => {
  const { store } = scratch();
  assert.throws(() => compactStore({ store, dryRun: true }), /no store at/);
});
