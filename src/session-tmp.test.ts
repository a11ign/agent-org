// no-token: none -- herdr is a fake that records the workspaces it is asked to open; the directories are a test's own and nothing is spawned
//
// A11-303: EVERY AGENT SESSION THE BOARD STARTS HAS A PRIVATE TMPDIR. The reviewers the board started had none, and their acceptance and mutation runs refilled the host's /tmp at ~440 entries an hour. One test per kind of
// session the board starts: a ticket's run (the pool's `start`), a new-ticket run (the writer), a publish run, and a reviewer (the gate's `spawnReviewer`, and the atomic plugin that calls it for the pool).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPane } from "./herdr-agents.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { createFakePublisher } from "./plugins/fakes/publisher.ts";
import { reviewingHelpers } from "./plugins/reviewing-helpers.ts";
import { INSIDE, OUTSIDE } from "./review-trust.ts";
import { privateTmpEnv, runTmpDir } from "./session-tmp.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { poolFixture } from "./ticket-mode/pool-fixture.ts";
import { herdrName } from "./ticket-mode/pool.ts";
import { moduleSource } from "./lib/source-text-reads.ts";
import { loadReviewerGate } from "./ticket-mode/reviewer-port.ts";
import { queueWriter } from "./ticket-mode/queue.ts";
import { spawnReviewer } from "./wake/reviewer-tokens-and-checkouts.ts";
import { atomicReviewerPort } from "../plugins/atomic-reviewer/port.ts";
import { REPO } from "./project-identity.ts";

/** The `--env` pairs of each `workspace create` in `calls`, in order. */
const createdWith = (calls: readonly string[][]): Record<string, string>[] => calls.filter((args) => args.includes("workspace") && args.includes("create"))
  .map((args) => Object.fromEntries(args.flatMap((arg, at) => (args[at - 1] === "--env" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : []))));

/** A herdr that records its calls and opens `w1:p1` for a `workspace create`. */
function recordingHerdr() {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    return args.includes("create") ? JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" }, workspace: { workspace_id: "w1" } } }) : "{}";
  };
  return { calls, run };
}

test("A11-303: privateTmpEnv makes the session's directory under the base and names it, and says why it could not", () => {
  const base = tmpDir("session-tmp-");
  assert.deepEqual(privateTmpEnv(undefined, "reviewer-7"), { env: {} }, "a board that gives sessions no base gives none");
  assert.deepEqual(privateTmpEnv(base, "reviewer-7"), { env: { TMPDIR: join(base, "run-t-reviewer-7") } });
  assert.ok(existsSync(join(base, "run-t-reviewer-7")));
  assert.deepEqual(privateTmpEnv(base, "reviewer-7"), { env: { TMPDIR: join(base, "run-t-reviewer-7") } }, "a session started again under its label has its directory");
  writeFileSync(join(base, "a-file"), "");
  const refused = privateTmpEnv(join(base, "a-file"), "reviewer-7");
  assert.deepEqual(refused.env, {});
  assert.match(refused.refusal ?? "", /ENOTDIR/);
});

test("A11-303: openPane opens the pane with TMPDIR naming a directory it made for the label, and a TMPDIR the caller named is left as it is", () => {
  const base = tmpDir("session-tmp-");
  const herdr = recordingHerdr();
  assert.ok("pane" in openPane(herdr.run, "reviewer-7", { A: "1" }, "/work/tree", { tmpBase: base }));
  assert.deepEqual(createdWith(herdr.calls), [{ A: "1", TMPDIR: join(base, "run-t-reviewer-7") }]);
  assert.deepEqual(readdirSync(base), ["run-t-reviewer-7"]);

  const named = recordingHerdr();
  openPane(named.run, "NBF-1", { TMPDIR: "/the/runs/own" }, undefined, { tmpBase: base });
  assert.deepEqual(createdWith(named.calls), [{ TMPDIR: "/the/runs/own" }], "a ticket's run carries the one runEnvOf built, made before this");
  assert.deepEqual(readdirSync(base), ["run-t-reviewer-7"], "and no second directory is made for it");

  const bare = recordingHerdr();
  openPane(bare.run, "reviewer-7", { A: "1" }, undefined, {});
  assert.deepEqual(createdWith(bare.calls), [{ A: "1" }], "no base: no TMPDIR, as every caller that does not give one");
});

test("A11-303: a pane whose directory cannot be made is still opened, without a TMPDIR", () => {
  const base = tmpDir("session-tmp-");
  writeFileSync(join(base, "a-file"), "");
  const herdr = recordingHerdr();
  assert.ok("pane" in openPane(herdr.run, "reviewer-7", { A: "1" }, undefined, { tmpBase: join(base, "a-file") }));
  assert.deepEqual(createdWith(herdr.calls), [{ A: "1" }]);
});

test("A11-303: a reviewer the gate starts has a TMPDIR under the board's base, in its own directory, inside or outside the org", async () => {
  await loadReviewerGate();
  const base = tmpDir("session-tmp-");
  for (const [session, trust] of [["reviewer-2398", INSIDE], ["reviewer-2399", OUTSIDE]] as const) {
    const herdr = recordingHerdr();
    const started = spawnReviewer({ session, cause: "draft-awaiting-verdict", causeKey: `${session}/draft-awaiting-verdict/pr-1/abc12345`, trust }, [], { run: herdr.run, cwd: tmpDir("session-tmp-tree-"), tmpBase: base });
    assert.ok("workspace" in started, JSON.stringify(started));
    assert.equal(createdWith(herdr.calls)[0]!.TMPDIR, runTmpDir(base, session), `${session} is opened with its own directory`);
    assert.equal(createdWith(herdr.calls)[0]!.A11Y_REVIEWER_SESSION ?? session, session, "beside the variables it always had");
  }
  const bare = recordingHerdr();
  spawnReviewer({ session: "reviewer-2400", cause: "draft-awaiting-verdict", causeKey: "reviewer-2400/draft-awaiting-verdict/pr-1/abc12345", trust: INSIDE }, [], { run: bare.run, cwd: tmpDir("session-tmp-tree-") });
  assert.equal("TMPDIR" in createdWith(bare.calls)[0]!, false, "a caller that gives no base starts it as it was");
});

const OWNER = REPO.split("/")[0];

/** The atomic reviewer's port over a board that names `tmpBase`, recording the options its spawn is called with. */
function reviewerPort(tmpBase: string | undefined) {
  const spawned: { tmpBase?: string; env?: Record<string, string> }[] = [];
  const codeHost = createFakeCodeHost("worker-bot");
  codeHost.seedPull(`${OWNER}/plugin`, 7, { head: "h1", state: "open", trust: "inside", settled: true, reviews: [] });
  const entries: { id: number; description: string; created: number }[] = [];
  const host = { ...codeHost, readReviewClaims: async () => ({ entries }), writeReviewClaim: async ({ description }: { description: string }) => { entries.push({ id: entries.length + 1, description, created: Date.now() }); return null; } };
  const run = (args: string[]) => (args.includes("workspace") && args.includes("list") ? JSON.stringify({ result: { workspaces: [] } }) : "{}");
  const helpers = reviewingHelpers({ session: "tickets", run, runAsync: async (args) => run(args), codeHost: () => host, clones: { plugin: "/repos/plugin" }, instance: "work", heads: new Map(), ...(tmpBase === undefined ? {} : { tmpBase }) });
  const port = atomicReviewerPort(helpers, { mint: async () => null, exists: () => false, checkout: async () => ({ path: "/work/pr-7", head: "h1" }), removeCheckout: async () => null,
    spawn: async (order, _agents, options) => { spawned.push({ ...(options.tmpBase === undefined ? {} : { tmpBase: options.tmpBase }), ...(options.env === undefined ? {} : { env: options.env }) }); return { label: order.session, workspace: "w1", profile: { kind: "codex", model: "m", effort: "e" } }; } });
  return { port, spawned };
}

test("A11-303: the reviewer the board's atomic plugin starts is given the board's base, and a board that names none gives it none", async () => {
  await loadReviewerGate();
  const given = reviewerPort("/base");
  assert.ok("label" in await given.port.start({ pr: `https://github.com/${OWNER}/plugin/pull/7`, head: "h1" }));
  assert.equal(given.spawned[0]!.tmpBase, "/base");
  assert.equal("TMPDIR" in (given.spawned[0]!.env ?? {}), false, "the base is a spawn option and not an environment: the door runs with the reviewer's environment too, when the directory may be gone");
  const none = reviewerPort(undefined);
  await none.port.start({ pr: `https://github.com/${OWNER}/plugin/pull/7`, head: "h1" });
  assert.equal(none.spawned[0]!.tmpBase, undefined);
});

test("A11-303: a new-ticket run (the writer) is opened with a TMPDIR of its own under the pool's base", async () => {
  const base = tmpDir("session-tmp-");
  const made = poolFixture({ keys: [], tickets: { writer: { run: "Run the a11ign:create-ticket skill for this request: {request}, in {dir}." } }, privateTmpBase: base });
  made.store.set(queueWriter(made.store.get(), { id: "w1", request: "Show the requests a person made", mode: "quick", placement: "manual", form: { repo: "nbl-ui-netbox" } }, 0));
  await made.pool.tick();
  const label = herdrName("writer-w1");
  assert.deepEqual(createdWith(made.herdr.calls).map((env) => env.TMPDIR), [runTmpDir(base, label)]);
  assert.ok(existsSync(runTmpDir(base, label)));
});

test("A11-303: a publish run is opened with a TMPDIR of its own under the pool's base", async () => {
  const base = tmpDir("session-tmp-");
  const made = poolFixture({ keys: [], tickets: { publish: { run: "Run the post-pr-to-slack skill on these pull requests, all in one go: {prs}. Then write {dir}/published.json", connectors: ["^mcp__chat__send"] } }, privateTmpBase: base });
  made.store.set({ ...made.store.get(), publish: { id: "p1", keys: [], prs: [], phase: "queued", queuedAt: 0 } });
  const pool = made.restart({ publisher: createFakePublisher(["^mcp__chat__send"]) });
  await pool.tick();
  const label = herdrName("publish-p1");
  assert.deepEqual(createdWith(made.herdr.calls).map((env) => env.TMPDIR), [runTmpDir(base, label)]);
  assert.ok(existsSync(runTmpDir(base, label)));
});

test("A11-303: the board's instance and the on-demand review command give their sessions the private base, and the instance names /tmp for the legacy sweep", () => {
  assert.match(moduleSource("ticket-mode/server.ts"), /reviewingBeforeActivation\(\{[^}]*tmpBase: privateBase\(\) \}\)/, "the instance's reviewers are started under the private base");
  assert.match(moduleSource("ticket-mode/server.ts"), /privateTmpBase: privateBase\(\), legacyTmp: \{ root: LEGACY_TMP_ROOT \}/, "and its pool makes its runs' directories there and sweeps /tmp");
  assert.match(moduleSource("ticket-mode/review-command.ts"), /reviewingBeforeActivation\(\{[^}]*tmpBase: privateBase\(\) \}\)/, "a reviewer started by `ticket:review` is started under it too");
});
