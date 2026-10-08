// a11ign/a11ign#4184 (#4055 next wave, item 5): the headless pilot's script, against a FAKE `claude` and a STUB `gh`. No model, no network, no org write.
// Run with `AGENT_ORG_HOST=<checkout>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.mjs src/trace/headless-pilot.test.ts`.
// The git side is real (a local bare `origin` and a clone), so the throwaway worktree is a real worktree and "it does not exist afterwards" is read off the disk.
// no-token: gh -- `gh` is an injected stub that fails the run on any write; wake.mjs is imported for `addressed` only and its gh readers are never called here
// Every claim carries a positive control (the same input made valid passes) and a negative one (the input that must be refused or must fail does), so none is an emptiness assertion.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArgs, profileFor } from "../worker-profile.mjs";
import { addressed } from "../wake.mjs";
import {
  MEASUREMENT_TAIL, assertGhRead, earlyRefusal, fleetAnswerOf, launchArgs, normalizeArgv, pilotRowsOf, runPilot, successOf, userTurn,
} from "./headless-pilot.mjs";

const CAPS = { maxTurns: 40, maxBudgetUsd: 2.5 };
const NAMED_ON = 4200;
const EVEN_ROW = 4300;
const SONNET = "claude-sonnet-5-5";

const rowBody = (fleet = "No -- a unit test.", acceptance = "test -f accept.ok") => [
  "## Region", "", "```", "a11ign:src/x.mjs", "```", "", "## Acceptance", "", "```bash", acceptance, "```", "", "## Fleet", "", fleet, ""].join("\n");

type Labels = string[];
const issue = (number: number, { state = "OPEN", labels = [] as Labels, body = rowBody(), title = `row ${number}` } = {}) =>
  ({ number, state, title, body, labels: labels.map((name) => ({ name })) });

/** The fake `claude`: records every launch, then plays the stream a test asks for through FAKE_* environment variables. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
if (process.argv[2] === "--version") { console.log("9.9.9 (Fake Code)"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const push = spawnSync("git", ["push", "origin", "HEAD:refs/heads/pilot-leak"], { encoding: "utf8" });
  appendFileSync(process.env.FAKE_DIR + "/calls.jsonl", JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(), stdin, pushExit: push.status,
    env: { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 },
  }) + "\\n");
  if (process.env.FAKE_ACCEPT === "pass") writeFileSync("accept.ok", "ok");
  const sid = "11111111-2222-3333-4444-555555555555";
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-fake-cwd");
  mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
  const turn = (id, model) => JSON.stringify({ type: "assistant", timestamp: "2026-10-08T12:00:0" + id.slice(-1) + "Z", requestId: "req_" + id, message: { id, model, role: "assistant", content: [{ type: "text", text: "x" }], usage } });
  writeFileSync(join(dir, sid + ".jsonl"), [turn("msg_1", "${SONNET}"), turn("msg_2", "${SONNET}"), turn("msg_3", "model-with-no-price")].join("\\n") + "\\n");
  console.log("some chatter that is not json");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
  console.log(JSON.stringify({ type: "result", subtype: process.env.FAKE_SUBTYPE, is_error: process.env.FAKE_SUBTYPE !== "success", num_turns: 6, total_cost_usd: 0.123, session_id: sid }));
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
});
`;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); }); // the private-tmp guard fails a file that leaves a fixture behind

function fixture(issues: Record<number, ReturnType<typeof issue>>) {
  const root = mkdtempSync(join(tmpdir(), "headless-pilot-test-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  sh(root, "init", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, checkout);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(checkout, "config", k, v);
  writeFileSync(join(checkout, "README.md"), "x\n");
  sh(checkout, "add", "."); sh(checkout, "commit", "-q", "-m", "init"); sh(checkout, "push", "-q", "origin", "HEAD:main"); sh(checkout, "fetch", "-q", "origin");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const ghCalls: string[][] = [];
  const gitCalls: string[][] = [];
  const ghStub = (args: string[]) => {
    ghCalls.push(args);
    // the stub FAILS THE RUN on anything but a read, whatever the script's own guard did before it
    if (!(args[0] === "issue" && args[1] === "view") && !(args[0] === "api" && !args.includes("-X"))) throw new Error(`STUB gh: a write reached the org: gh ${args.join(" ")}`);
    return JSON.stringify(issues[Number(args[2])] ?? (() => { throw new Error(`no such issue ${args[2]}`); })());
  };
  const git = (args: string[]) => { gitCalls.push(args); return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); };
  const deps = { gh: ghStub, git, claudeBin: join(bin, "claude"), scratch: join(root, "scratch"), checkout, recordDir: join(root, "records"), configDir: join(root, "claude-config"), out: () => {} };
  process.env.FAKE_DIR = root;
  process.env.CLAUDE_CONFIG_DIR = deps.configDir;
  const launches = () => (existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { root, deps, ghStub, ghCalls, gitCalls, launches, worktree: join(deps.scratch, `wt-${EVEN_ROW}`) };
}

const validIssues = () => ({ [NAMED_ON]: issue(NAMED_ON, { body: `Pilot rows.\nPilot-rows: ${EVEN_ROW}, 4302\n` }), [EVEN_ROW]: issue(EVEN_ROW) });
const options = (over = {}) => ({ row: EVEN_ROW, namedOn: NAMED_ON, caps: CAPS, dryRun: false, ...over });
const play = (subtype: string, accept: "pass" | "fail", exit = 0) => { process.env.FAKE_SUBTYPE = subtype; process.env.FAKE_ACCEPT = accept; process.env.FAKE_EXIT = String(exit); };
const refusedWith = (got: any) => ("refused" in got ? got.refused.refusal : null);

test("the arguments claude is launched with EQUAL agentArgs(profile, { headless }) for the per-row engineer profile, with the given caps", async () => {
  const f = fixture(validIssues());
  play("success", "pass");
  await runPilot(options(), f.deps);
  const [launch] = f.launches();
  const profile = profileFor("ready-row-unclaimed") as { kind: string; model: string; effort: string };
  assert.deepEqual(launch.args, agentArgs(profile, { headless: CAPS }), "a script that built its own flags is red");
  assert.equal(launch.args[launch.args.indexOf("--max-turns") + 1], "40");
  assert.equal(launch.args[launch.args.indexOf("--max-budget-usd") + 1], "2.5");
  // negative control: other caps are other arguments, and the pane form is not this one
  assert.notDeepEqual(launch.args, agentArgs(profile, { headless: { maxTurns: 41, maxBudgetUsd: 2.5 } }));
  assert.notDeepEqual(launch.args, agentArgs(profile));
  assert.deepEqual(launchArgs(CAPS), launch.args);
});

test("the order is the pane worker's first-contact order for the row (addressed() with the spawned facts) plus the measurement tail", async () => {
  const f = fixture(validIssues());
  play("success", "pass");
  await runPilot(options(), f.deps);
  const [launch] = f.launches();
  const sent = JSON.parse(launch.stdin.trim());
  assert.equal(sent.type, "user");
  const claimed = { row: EVEN_ROW, branch: `pilot/headless-${EVEN_ROW}`, launchDir: f.worktree, worktree: f.worktree };
  const paneForm = addressed({ session: `pilot-${EVEN_ROW}`, prompt: "", title: `row ${EVEN_ROW}`, cause: "ready-row-unclaimed" }, `pilot-${EVEN_ROW}`, { spawned: claimed, engineers: [] });
  assert.equal(sent.message.content, `${paneForm}\n\n${MEASUREMENT_TAIL}`);
  assert.ok(sent.message.content.includes(`Row #${EVEN_ROW}: row ${EVEN_ROW} has been claimed for you`), "positive control: the pane worker's sentence is in it");
  assert.ok(sent.message.content.includes("read `.agent-org/roles/engineer.md`") || /engineer\.md/.test(sent.message.content));
  assert.equal(userTurn("a\nb"), `${JSON.stringify({ type: "user", message: { role: "user", content: "a\nb" } })}\n`);
});

test("each refusal fires for its own input and is silent for the same input made valid", async () => {
  const baseline = fixture(validIssues());
  play("success", "pass");
  const ok = await runPilot(options({ dryRun: true }), baseline.deps);
  assert.equal(refusedWith(ok), null, "positive control for all of them: an even, named, unclaimed, fleet-free row passes");

  const cases: [string, any, Record<number, any>][] = [
    ["odd-row", options({ row: EVEN_ROW + 1 }), { ...validIssues(), [EVEN_ROW + 1]: issue(EVEN_ROW + 1) }],
    ["not-named", options({ row: 4304 }), { ...validIssues(), 4304: issue(4304) }],
    ["claimed", options(), { ...validIssues(), [EVEN_ROW]: issue(EVEN_ROW, { labels: ["lane:any", "session:worker-9"] }) }],
    ["fleet", options(), { ...validIssues(), [EVEN_ROW]: issue(EVEN_ROW, { body: rowBody("Yes -- needs the lab.") }) }],
    ["fleet", options(), { ...validIssues(), [EVEN_ROW]: issue(EVEN_ROW, { body: rowBody("").replace(/## Fleet[^]*/, "") }) }],
    ["missing-cap", options({ caps: { maxTurns: 40 } }), validIssues()],
    ["missing-cap", options({ caps: { maxBudgetUsd: 2.5 } }), validIssues()],
    ["not-open", options(), { ...validIssues(), [EVEN_ROW]: issue(EVEN_ROW, { state: "CLOSED" }) }],
  ];
  for (const [expected, opts, issues] of cases) {
    const f = fixture(issues);
    play("success", "pass");
    const got = await runPilot({ ...opts, dryRun: true }, f.deps);
    assert.equal(refusedWith(got), expected, `${expected} must fire`);
    assert.equal(f.launches().length, 0);
  }
  // a row NOT carrying a session label, with another label, is not "claimed"
  const other = fixture({ ...validIssues(), [EVEN_ROW]: issue(EVEN_ROW, { labels: ["lane:any", "ready"] }) });
  assert.equal(refusedWith(await runPilot(options({ dryRun: true }), other.deps)), null);
});

test("the pure refusals, one by one: early, fleet answer, Pilot-rows line, flag spelling", () => {
  assert.equal(earlyRefusal({ row: 4300, caps: CAPS, namedOn: 1 }), null);
  assert.equal(earlyRefusal({ row: 4301, caps: CAPS, namedOn: 1 })?.refusal, "odd-row");
  assert.equal(earlyRefusal({ row: 4300, caps: {}, namedOn: 1 })?.refusal, "missing-cap");
  assert.equal(fleetAnswerOf(rowBody("No -- x")), "no");
  assert.equal(fleetAnswerOf(rowBody("Yes -- x")), "yes");
  assert.equal(fleetAnswerOf(rowBody("Nobody knows")), null, "'Nobody' is not No");
  assert.deepEqual(pilotRowsOf("x\nPilot-rows: #4300, 4302 and 4304\ny"), [4300, 4302, 4304]);
  assert.equal(pilotRowsOf("no line"), null);
  assert.equal(pilotRowsOf("Pilot-rows: 4300\nPilot-rows: 4302"), null, "two lines are ambiguous, not merged");
  assert.deepEqual(normalizeArgv(["--row", "4300", "--dry-run", "--max-turns=5", "--named-on", "9"]), ["--row=4300", "--dry-run", "--max-turns=5", "--named-on=9"]);
});

test("success is true only when the result is `success` AND the Acceptance exited 0; a cap stop is written as false, never dropped", async () => {
  const cases: [string, "pass" | "fail", boolean][] = [
    ["success", "pass", true],
    ["error_max_turns", "pass", false],
    ["success", "fail", false],
    ["error_max_budget_usd", "fail", false],
  ];
  for (const [subtype, accept, expected] of cases) {
    const f = fixture(validIssues());
    play(subtype, accept, subtype === "success" ? 0 : 1);
    const got: any = await runPilot(options(), f.deps);
    const written = JSON.parse(readFileSync(join(f.deps.recordDir, `${EVEN_ROW}.json`), "utf8"));
    assert.equal(written.success, expected, `${subtype} + acceptance ${accept}`);
    assert.equal(written.resultSubtype, subtype);
    assert.equal(written.acceptanceExitCode, accept === "pass" ? 0 : 1);
    assert.equal(written.exitCode, subtype === "success" ? 0 : 1);
    assert.deepEqual(got.record, written);
  }
  assert.equal(successOf("success", 0), true);
  assert.equal(successOf("success", null), false);
  assert.equal(successOf(null, 0), false);
});

test("the record carries the fields the row names, with the trace store's dollars beside the CLI's unused figure", async () => {
  const f = fixture(validIssues());
  play("success", "pass");
  const got: any = await runPilot(options(), f.deps);
  const r = got.record;
  assert.equal(r.row, EVEN_ROW);
  assert.equal(r.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(r.claudeVersion, "9.9.9 (Fake Code)");
  assert.deepEqual(r.caps, CAPS);
  assert.equal(r.numTurns, 6);
  assert.equal(r.cliTotalCostUsd, 0.123);
  // two priced turns of 1000 in + 500 out at Sonnet 5.5's $2 / $10 per million = 2 x 0.007; the third turn's model has no price, so the sum is a floor and says so
  assert.ok(Math.abs(r.traceCostUsd - 0.014) < 1e-9, `trace cost ${r.traceCostUsd}`);
  assert.equal(r.traceApiCalls, 3);
  assert.equal(r.unpricedTurns, 1);
  assert.notEqual(r.traceCostUsd, r.cliTotalCostUsd, "the two figures are different readings and are kept apart");
  // negative control: no transcript means null, never 0
  const missing = fixture(validIssues());
  play("success", "pass");
  const none: any = await runPilot(options(), { ...missing.deps, configDir: join(missing.root, "elsewhere") });
  assert.equal(none.record.traceCostUsd, null);
});

test("a second run of a row renames the first record aside rather than overwriting it", async () => {
  const f = fixture(validIssues());
  play("success", "pass");
  await runPilot(options(), f.deps);
  play("error_max_turns", "fail", 1);
  await runPilot(options(), f.deps);
  assert.equal(readdirSync(f.deps.recordDir).length, 2);
  assert.equal(JSON.parse(readFileSync(join(f.deps.recordDir, `${EVEN_ROW}.json`), "utf8")).success, false);
});

test("gh is only ever read: the stub saw reads, git never pushed, and the worker's own push fails", async () => {
  const f = fixture(validIssues());
  play("success", "pass");
  await runPilot(options(), f.deps);
  assert.ok(f.ghCalls.length >= 2, "positive control: gh WAS called, so 'only reads' is not vacuous");
  for (const call of f.ghCalls) assert.ok(call[0] === "issue" && call[1] === "view", `non-read: gh ${call.join(" ")}`);
  assert.ok(f.gitCalls.length > 0 && f.gitCalls.every((c) => !c.includes("push")), "the script itself never pushes");
  const [launch] = f.launches();
  assert.deepEqual(launch.env, { count: "1", key: "remote.origin.pushurl", value: "headless-pilot-refuses-push" });
  assert.notEqual(launch.pushExit, 0, "the worker's `git push` failed");
  assert.equal(sh(f.deps.checkout, "ls-remote", "--heads", "origin", "pilot-leak").trim(), "", "nothing reached origin");
});

test("assertGhRead refuses a write and passes a read", () => {
  for (const write of [["issue", "edit", "1", "--add-label", "x"], ["issue", "comment", "1", "-b", "x"], ["pr", "create"], ["api", "-X", "POST", "repos/a/b/issues"],
    ["api", "repos/a/b/issues", "-f", "title=x"], ["api", "--method", "PATCH", "x"], ["api", "x", "--input", "f.json"]]) {
    assert.throws(() => assertGhRead(write), /read-only against the org/, `gh ${write.join(" ")}`);
  }
  for (const read of [["issue", "view", "1", "--json", "body"], ["api", "repos/a/b/issues/1"], ["api", "-X", "GET", "x"]]) assert.doesNotThrow(() => assertGhRead(read));
});

test("the stub itself fails on a write (the negative control for the stub)", () => {
  const f = fixture(validIssues());
  for (const write of [["issue", "edit", "1"], ["issue", "comment", "1"], ["pr", "create"]]) assert.throws(() => f.ghStub(write), /a write reached the org/);
  assert.doesNotThrow(() => f.ghStub(["issue", "view", String(EVEN_ROW)]));
});

test("the throwaway worktree is gone after a run that succeeds AND after one that fails", async () => {
  for (const [subtype, accept, exit] of [["success", "pass", 0], ["error_max_turns", "fail", 1]] as const) {
    const f = fixture(validIssues());
    play(subtype, accept, exit);
    await runPilot(options(), f.deps);
    const [launch] = f.launches();
    assert.equal(launch.cwd.endsWith(`wt-${EVEN_ROW}`), true, "positive control: the run happened in the worktree");
    assert.equal(existsSync(f.worktree), false, `${subtype}: worktree removed`);
    assert.doesNotMatch(sh(f.deps.checkout, "worktree", "list"), /wt-4300/);
    assert.equal(sh(f.deps.checkout, "branch", "--list", `pilot/headless-${EVEN_ROW}`).trim(), "", "and so is its branch");
  }
  // a claude that cannot start still leaves a record and no worktree
  const f = fixture(validIssues());
  const got: any = await runPilot(options(), { ...f.deps, claudeBin: join(f.root, "no-such-claude") });
  assert.equal(got.record.success, false);
  assert.ok(got.record.launchError);
  assert.equal(existsSync(f.worktree), false);
});

test("a leftover worktree path is refused, not deleted", async () => {
  const f = fixture(validIssues());
  mkdirSync(f.worktree, { recursive: true });
  assert.equal(refusedWith(await runPilot(options(), f.deps)), "worktree-exists");
  assert.equal(existsSync(f.worktree), true);
  assert.equal(f.launches().length, 0);
});

test("--dry-run launches nothing, makes no worktree and prints the arguments and the first 20 lines of the order", async () => {
  const f = fixture(validIssues());
  play("success", "pass");
  const printed: string[] = [];
  const got: any = await runPilot(options({ dryRun: true }), { ...f.deps, out: (line: string) => printed.push(line) });
  assert.equal(f.launches().length, 0, "the fake claude recorded zero invocations");
  assert.equal(existsSync(f.worktree), false);
  assert.equal(existsSync(f.deps.recordDir), false);
  assert.deepEqual(got.args, launchArgs(CAPS));
  assert.ok(printed[0].startsWith("claude ") && printed[0].includes("--max-turns") && printed[0].includes("\"40\""));
  assert.ok(printed.length <= 22 && printed.length > 3, `${printed.length} lines`);
  assert.ok(printed.some((line) => line.includes(`Row #${EVEN_ROW}`)));
  // negative control: the same input without --dry-run DOES launch
  play("success", "pass");
  await runPilot(options(), f.deps);
  assert.equal(f.launches().length, 1);
});
