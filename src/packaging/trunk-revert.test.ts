// no-token: gh -- this file drives `trunkRedOrders`, `attributionOf`, `readTrunkRed` (through an injected
// `run`, never the real `gh`) and `decide`, all with fixture data; `readTrunkRed`'s default `gh` is never reached.
/**
 * A RED `main` WAKES A FIXER, AND NOTHING REVERTS ANYTHING -- #2356, the chairman's ruling of 2026-09-24:
 * THE ORG ALWAYS FIXES FORWARD.
 *
 * THE FILE KEEPS THE NAME IT HAD WHEN IT TESTED THE REVERT, because the row's Region and Acceptance name it
 * and a rename is a second change nobody asked for. What it pins is the replacement:
 *
 *   1. A failing `trunkBuildTest` (or `trunkGate`) on main's tip emits ONE order, naming the test, the run and
 *      the merge, saying "fix forward" -- whether the parent re-check calls the failure this merge's own,
 *      inherited, or could not say.
 *   2. Own or unknown goes to the session that merged it, falling back to `engineers` when that session is
 *      gone; inherited goes straight to `engineers`, because nothing about it is the merged PR's own.
 *   3. It is the FIRST order `decide` emits, and a drain does not withhold it.
 *   4. THE POLICY that was asked to be decided is written down (`RED_TRUNK_POLICY`) and pinned here.
 *   5. NO WORKFLOW opens a `revert/` branch or pull request, calls `git revert`, or holds the grants one
 *      would need, and the script that did is gone.
 *
 * The two real near-misses the old decision was built around still matter, now as attribution rather than as
 * a gate on action: 13 of 19 PRs read red on one bad commit and none was at fault (#316), and a parent
 * measured green sixty-one minutes earlier failed a wall-clock assertion when asked again (#616).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { attributionOf, failingTestsFromJobLog, newestVerdictRun, readTrunkRed, recheckFromAnnotations,
  trunkRedOrders, RED_TRUNK_POLICY, RECHECK_JOB, RECHECK_ANNOTATION_TITLE, MAX_RECORDED_PARENT_FAILURES }
  from "../trunk-red.mjs";
import { decide, CAUSES, JUDGMENT_CAUSES, START_CAUSES } from "../work-gate.mjs";
import { routeWithFallback } from "../wake.mjs";
import { HOME_CHECKOUT } from "../project-config.mjs";

// The workflows are the PROJECT's; the scripts they run are the tool's, which is this checkout's `src` (the project's `packages/agent-org` is the old frozen copy).
const TOOL_SRC = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS = path.join(HOME_CHECKOUT, ".github/workflows");
const TRUNK = readFileSync(path.join(WORKFLOWS, "trunk.yml"), "utf8");

const SHA = "a1b2c3d4e5f6789012345678901234567890abcd";
const TEST = "the README's quickstart workflow is one a stranger can actually paste";
const RUN_URL = "https://github.com/a11ign/a11ign/actions/runs/34767797651";

type Red = NonNullable<ReturnType<typeof readTrunkRed>>;
const red = (over: Partial<Red> = {}): Red => ({
  runId: 34767797651, url: RUN_URL, sha: SHA, failedJobs: ["trunkBuildTest / run"], failingTests: [TEST],
  recheck: "pass", parentFailingTests: null,
  originPr: { number: 2372, title: "a change that broke the quickstart", session: "worker-tooling" },
  ...over,
});

// --- 1. the order: what it names, whichever way the re-check went ---

test("OWN failure: one order naming the test, the run and the merge, saying FIX FORWARD", () => {
  const orders = trunkRedOrders(red());
  assert.equal(orders.length, 1);
  const [o] = orders;
  assert.equal(o.cause, "trunk-red");
  assert.ok(CAUSES.includes(o.cause), "an order whose cause the gate cannot emit is rejected by wake");
  assert.match(o.prompt, new RegExp(TEST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the failing test");
  assert.ok(o.prompt.includes(RUN_URL), "the run");
  assert.ok(o.prompt.includes("#2372") && o.prompt.includes(SHA.slice(0, 8)), "the merge, by PR and by sha");
  assert.match(o.prompt, /FIX FORWARD -- DO NOT REVERT/);
  assert.match(o.prompt, /THIS MERGE'S OWN/);
  assert.equal(o.session, "worker-tooling", "the session that merged it holds the context");
  assert.equal(o.fallback, "engineers", "and a way out when that session cannot be woken");
});

test("INHERITED failure: the order is STILL emitted, to the pool, and says nothing is this merge's own", () => {
  const [o] = trunkRedOrders(red({ recheck: "fail", parentFailingTests: [TEST, "an unrelated live-data flake"] }));
  assert.ok(o, "an inherited red is still red -- the ruling says nothing about it is the merged PR's, not that it waits");
  assert.equal(o.session, "engineers", "waking a PR's author for a failure they did not cause is the old misattribution");
  assert.equal(o.fallback, undefined, "the pool is already the widest address");
  assert.match(o.prompt, /INHERITED/);
  assert.match(o.prompt, /FIX FORWARD -- DO NOT REVERT/);
  assert.ok(o.prompt.includes(TEST));
});

test("a DISJOINT parent failure (#1359, the 2026-09-13 live-data flake) is still THIS merge's own", () => {
  // The real incident: the push failed test 722 (the README quickstart guard); the parent re-check failed
  // too, but on two live-data tests this push never touched. A bare "the parent fails" flag called it
  // inherited and refused; the shared-test comparison is what tells the two apart.
  const a = attributionOf({ recheck: "fail", pushFailingTests: [TEST],
    parentFailingTests: ["fetchLabels against the real #55, live", "#771 ACCEPTANCE, LIVE"] });
  assert.equal(a.kind, "own");
  const b = attributionOf({ recheck: "fail", pushFailingTests: [TEST, "x"], parentFailingTests: [TEST, "y"] });
  assert.equal(b.kind, "inherited", "ONE shared test among several is still the same failure");
  assert.deepEqual(b.shared, [TEST]);
});

test("UNKNOWN is its own answer, never folded into either: it still wakes the merge's session, and says so", () => {
  for (const facts of [
    { recheck: "unknown" as const, pushFailingTests: [TEST], parentFailingTests: null },
    { recheck: "fail" as const, pushFailingTests: null, parentFailingTests: ["x"] },
    { recheck: "fail" as const, pushFailingTests: ["x"], parentFailingTests: null },
  ]) assert.equal(attributionOf(facts).kind, "unknown", JSON.stringify(facts));
  const [o] = trunkRedOrders(red({ recheck: "unknown" }));
  assert.equal(o.session, "worker-tooling");
  assert.match(o.prompt, /COULD NOT SAY/);
});

test("a `trunkGate`-only failure (the silent-undo guard) is red too, and names the job when no test can be named", () => {
  const [o] = trunkRedOrders(red({ failedJobs: ["trunkGate"], failingTests: null }));
  assert.match(o.prompt, /`trunkGate`/);
  assert.match(o.prompt, /no failing test could be named/);
});

test("a merge with no identifiable PR goes to the pool, keyed on the sha", () => {
  const [o] = trunkRedOrders(red({ originPr: null }));
  assert.equal(o.session, "engineers");
  assert.equal(o.subject, `trunk-${SHA.slice(0, 8)}`);
  assert.ok(o.causeKey.includes(SHA.slice(0, 8)));
});

test("the causeKey names the merged PR, so wake's STUCK breaker can label it needs:chairman if nobody fixes it", () => {
  const [o] = trunkRedOrders(red());
  assert.match(o.causeKey, /\/pr-2372\//, "wake's `stuckRowOf` reads /pr-<n>/ out of the key");
  assert.equal(o.causeKey, `worker-tooling/trunk-red/pr-2372/${SHA.slice(0, 8)}`);
});

test("main is not red: no order", () => {
  assert.deepEqual(trunkRedOrders(null), []);
});

// --- 2. the session that merged it is gone: any idle engineer ---

test("MERGED SESSION GONE -> an idle engineer, through wake's own router", () => {
  const [o] = trunkRedOrders(red({ originPr: { number: 9, title: "t", session: "worker-5" } }));
  const roster = ["worker-capture", "worker-judge", "worker-tooling"];
  // `worker-5` was a spare instance: its workspace ended with its row, so herdr does not list it.
  const routed = routeWithFallback(o, [{ label: "worker-capture", status: "working" },
    { label: "worker-judge", status: "idle" }, { label: "worker-tooling", status: "working" }], roster);
  assert.deepEqual(routed, { label: "worker-judge" });
});

test("a session that CAN be woken is never bypassed for the pool", () => {
  const [o] = trunkRedOrders(red());
  const routed = routeWithFallback(o, [{ label: "worker-tooling", status: "idle" },
    { label: "worker-judge", status: "idle" }], ["worker-judge", "worker-tooling"]);
  assert.deepEqual(routed, { label: "worker-tooling" });
});

test("nobody at all: the refusal names BOTH the session and the fallback, and nothing is delivered", () => {
  const [o] = trunkRedOrders(red());
  const routed = routeWithFallback(o, [{ label: "worker-tooling", status: "working" }], ["worker-tooling"]);
  assert.ok("refusal" in routed);
  assert.match(String((routed as { refusal: string }).refusal), /worker-tooling.*fallback "engineers"/s);
});

test("an order with NO fallback behaves exactly as `route` always did", () => {
  const routed = routeWithFallback({ session: "ceo" }, [], ["worker-judge"]);
  assert.ok("refusal" in routed);
  assert.doesNotMatch(String((routed as { refusal: string }).refusal), /fallback/);
});

// --- 3. first in decide(), and a drain does not withhold it ---

test("the red-trunk order is the FIRST order decide() emits, ahead of even `answer-owed`, which was first before it", () => {
  const owed = { number: 914, labels: [{ name: "backlog" }, { name: "answer:product-manager" }] };
  const withRed = decide({ prs: [], readyRows: [], answerOwed: [owed], trunkRed: red() });
  assert.deepEqual(withRed.map((o: { cause: string }) => o.cause).slice(0, 2), ["trunk-red", "answer-owed"]);
  const without = decide({ prs: [], readyRows: [], answerOwed: [owed] });
  assert.equal(without[0].cause, "answer-owed",
    "POSITIVE CONTROL: without a red main the order that used to be first still is, so the swap is what is being seen");
  assert.deepEqual(withRed.slice(1).map((o: { cause: string }) => o.cause), without.map((o: { cause: string }) => o.cause));
});

test("a drain does not withhold it: fixing main is finishing work, not taking on new", () => {
  assert.ok(!START_CAUSES.includes("trunk-red"));
  assert.ok(decide({ prs: [], readyRows: [], drain: true, trunkRed: red() }).some((o) => o.cause === "trunk-red"));
});

test("it is an ACTION cause: wake re-offers it on the twenty-minute expiry until main is green", () => {
  assert.ok(!JUDGMENT_CAUSES.includes("trunk-red"),
    "a judgment cause is keyed on state and not re-asked, which is the wrong shape for a red main");
});

// --- reading the run: what counts as red ---

test("newestVerdictRun looks THROUGH a cancelled or running run, so neither hides a red nor raises one", () => {
  const runs = { workflow_runs: [
    { id: 4, head_sha: "d", status: "in_progress", conclusion: null, html_url: "u4", created_at: "2026-09-24T04:00:00Z" },
    { id: 3, head_sha: "c", status: "completed", conclusion: "cancelled", html_url: "u3", created_at: "2026-09-24T03:00:00Z" },
    { id: 2, head_sha: "b", status: "completed", conclusion: "failure", html_url: "u2", created_at: "2026-09-24T02:00:00Z" },
    { id: 1, head_sha: "a", status: "completed", conclusion: "success", html_url: "u1", created_at: "2026-09-24T01:00:00Z" },
  ] };
  assert.equal(newestVerdictRun(runs)?.id, 2);
  assert.equal(newestVerdictRun({ workflow_runs: [...runs.workflow_runs].reverse() })?.id, 2,
    "and not in whatever order the API happened to return them");
  assert.equal(newestVerdictRun({ workflow_runs: [] }), null);
  assert.equal(newestVerdictRun(null), null);
});

/** A `gh` stand-in answering by the shape of the request, recording every call. */
function fakeGh(state: { runs: unknown; jobs?: unknown; annotations?: unknown; log?: string; pulls?: unknown }) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const text = args.join(" ");
    if (text.includes("/actions/workflows/trunk.yml/runs")) return JSON.stringify(state.runs);
    if (/\/actions\/runs\/\d+\/jobs/.test(text)) return JSON.stringify(state.jobs ?? { jobs: [] });
    if (text.includes("/annotations")) return JSON.stringify(state.annotations ?? []);
    if (args[0] === "run" && args[1] === "view") return state.log ?? "";
    if (text.includes("/pulls")) return JSON.stringify(state.pulls ?? []);
    throw new Error(`unexpected gh call: ${text}`);
  };
  return { run, calls };
}

test("a HEALTHY main costs exactly ONE call, and reports nothing", () => {
  const gh = fakeGh({ runs: { workflow_runs: [{ id: 1, head_sha: SHA, status: "completed", conclusion: "success",
    html_url: RUN_URL, created_at: "2026-09-24T01:00:00Z" }] } });
  assert.equal(readTrunkRed(gh.run), null);
  assert.equal(gh.calls.length, 1, "GH_READS counts this as the one unconditional read");
});

test("a refused read is null, never a red: the gate does not invent an order from nothing", () => {
  assert.equal(readTrunkRed(() => { throw new Error("HTTP 403"); }), null);
});

test("END TO END with a fake gh: a red run yields the order, with the failing test read from the log", () => {
  const gh = fakeGh({
    runs: { workflow_runs: [{ id: 77, head_sha: SHA, status: "completed", conclusion: "failure", html_url: RUN_URL,
      created_at: "2026-09-24T02:00:00Z" }] },
    jobs: { jobs: [{ id: 501, name: "trunkGate", conclusion: "success" },
      { id: 502, name: "trunkBuildTest / run", conclusion: "failure" },
      { id: 503, name: RECHECK_JOB, conclusion: "success" }] },
    annotations: [{ title: RECHECK_ANNOTATION_TITLE, message: "RECHECK_RESULT=pass" }],
    log: `trunkBuildTest / run\tUNKNOWN STEP\t2026-09-13T16:11:51.3919318Z not ok 722 - ${TEST}\n`
      + "trunkBuildTest / run\tUNKNOWN STEP\t2026-09-13T16:14:53.1610523Z # fail 1\n",
    pulls: [{ number: 2372, title: "a change that broke the quickstart", labels: [{ name: "session:worker-tooling" }] }],
  });
  const found = readTrunkRed(gh.run);
  assert.ok(found, "a failure on main's newest verdict run is a red");
  assert.deepEqual(found.failingTests, [TEST]);
  assert.equal(found.recheck, "pass");
  assert.equal(found.originPr?.session, "worker-tooling");
  const [o] = trunkRedOrders(found);
  assert.equal(o.session, "worker-tooling");
  assert.ok(o.prompt.includes(TEST) && o.prompt.includes(RUN_URL) && o.prompt.includes("#2372"));
  // The recheck job's annotations are read by the JOB'S id -- an Actions job id is its check-run id.
  assert.ok(gh.calls.some((c) => c.join(" ").includes("check-runs/503/annotations")));
});

test("a failed side-read degrades ONE fact and still sends the order: a red main with no test named is still red", () => {
  const gh = fakeGh({ runs: { workflow_runs: [{ id: 77, head_sha: SHA, status: "completed", conclusion: "failure",
    html_url: RUN_URL, created_at: "2026-09-24T02:00:00Z" }] } });
  const found = readTrunkRed((args) => {
    if (args[0] === "api" && args.join(" ").includes("/workflows/trunk.yml/runs")) return gh.run(args);
    throw new Error("HTTP 403");
  });
  assert.ok(found);
  assert.equal(found.recheck, "unknown", "unreadable is unknown, never the pass that would blame the merge");
  assert.equal(found.originPr, null);
  assert.equal(trunkRedOrders(found)[0].session, "engineers");
});

// --- the recheck's hand-off ---

test("recheckFromAnnotations: pass, fail-with-tests, and anything unreadable is UNKNOWN never pass", () => {
  assert.deepEqual(recheckFromAnnotations([{ message: "RECHECK_RESULT=pass" }]),
    { result: "pass", parentFailingTests: null });
  const failed = recheckFromAnnotations([{ message: `RECHECK_RESULT=fail\nnot ok 3362 - ${TEST}\nnot ok 3363 - other` }]);
  assert.equal(failed.result, "fail");
  assert.deepEqual(failed.parentFailingTests, [TEST, "other"]);
  for (const bad of [null, [], [{ message: "" }], [{ message: "RECHECK_RESULT=green" }], [{}]]) {
    assert.equal(recheckFromAnnotations(bad as never).result, "unknown", JSON.stringify(bad));
  }
});

const REAL_LOG_EXCERPT = [
  "trunkGate\tSome step\t2026-09-13T16:10:00.0000000Z ok 1 - unrelated",
  `trunkBuildTest / run\tUNKNOWN STEP\t2026-09-13T16:11:51.3919318Z not ok 722 - ${TEST}`,
  "trunkBuildTest / run\tUNKNOWN STEP\t2026-09-13T16:14:53.1610523Z # fail 1",
].join("\n");

test("failingTestsFromJobLog reads a REAL gh run view --log-failed excerpt, timestamp and all (#1359)", () => {
  assert.deepEqual(failingTestsFromJobLog(REAL_LOG_EXCERPT, "trunkBuildTest / run"), [TEST]);
  assert.equal(failingTestsFromJobLog(REAL_LOG_EXCERPT, "someOtherJob"), null,
    "a job with no lines is null, never an empty array read as 'no failure'");
});

// --- the workflow and the contract it shares with the gate ---

const trunk = parseYaml(TRUNK) as { jobs: Record<string, { permissions?: Record<string, string>; needs?: string[];
  if?: string; steps?: { name?: string; run?: string; env?: Record<string, string>; if?: string }[] }> };

test("trunk.yml's job and annotation are the names the gate reads (one contract, two files)", () => {
  assert.ok(trunk.jobs[RECHECK_JOB], `trunk.yml must carry a job named ${RECHECK_JOB}`);
  const writes = (trunk.jobs[RECHECK_JOB].steps ?? []).map((s) => s.run ?? "").join("\n");
  assert.ok(writes.includes(`::notice title=${RECHECK_ANNOTATION_TITLE}::`),
    "the annotation title the workflow writes must be the one the gate looks for");
  assert.ok(writes.includes("RECHECK_RESULT="), "and the key the gate parses");
  assert.ok(writes.includes(`head -${MAX_RECORDED_PARENT_FAILURES}`), "and the bound on how many parent failures ride along");
});

test("the recheck job READS: no write grant, no PAT, and it runs on either job's failure only", () => {
  const job = trunk.jobs[RECHECK_JOB];
  assert.deepEqual(job.permissions, { contents: "read" },
    "it pushes nothing and opens nothing: a job that only reads must not hold a scope that could");
  assert.doesNotMatch(JSON.stringify(job), /A11IGN_BOT_TOKEN|secrets\./,
    "the PAT existed to open a revert pull request, and this job has nothing to open");
  assert.match(String(job.if), /needs\.trunkGate\.result == 'failure' \|\| needs\.trunkBuildTest\.result == 'failure'/);
});

test("the answer is recorded even when an earlier step died, and an unreadable answer is `unknown`", () => {
  const step = (trunk.jobs[RECHECK_JOB].steps ?? []).find((s) => (s.run ?? "").includes("::notice title="));
  assert.ok(step);
  assert.equal(step.if, "always()", "an earlier failure must still leave an answer");
  assert.match(step.run ?? "", /\*\) RECHECK_RESULT=unknown/, "anything that is not pass|fail|unknown is unknown");
});

// --- the parent re-check asks the question the RED job asked (#2389 review) ---

const REUSABLE = parseYaml(readFileSync(path.join(WORKFLOWS, "reusable-build-test.yml"), "utf8")) as
  { jobs: Record<string, { steps: { run?: string; name?: string }[] }> };

/** The commands `trunkBuildTest` runs for its verdict, read from the workflow it calls, not retyped here. */
const RED_JOB_BATTERY = Object.values(REUSABLE.jobs).flatMap((j) => j.steps).map((s) => (s.run ?? "").trim())
  .filter((run) => /^(pnpm run (lint|typecheck|test:all)|PYTHONDONTWRITEBYTECODE=1 pytest\b.*)$/.test(run));

/** lint, typecheck, the unscoped suite, pytest. */
const RED_JOB_COMMAND_COUNT = 4;

const PARENT_STEP = (trunk.jobs[RECHECK_JOB].steps ?? []).find((s) => s.name?.includes("parent fail the same check"))?.run ?? "";
/** The step's COMMANDS: its comments name `npm test` to explain why it is gone, and must not count as running it. */
const PARENT_COMMANDS = PARENT_STEP.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

test("POSITIVE CONTROL: the red job's battery was found, all four commands, and so was the parent step", () => {
  assert.equal(RED_JOB_BATTERY.length, RED_JOB_COMMAND_COUNT, `found: ${JSON.stringify(RED_JOB_BATTERY)}`);
  assert.ok(RED_JOB_BATTERY.includes("pnpm run test:all"), "the unscoped suite is the one that covers agent-org and lab");
  assert.ok(PARENT_STEP.length > 0);
});

test("the parent re-check runs EVERY command the red job ran, so a red in agent-org or lab cannot re-check green", () => {
  for (const command of RED_JOB_BATTERY) {
    assert.ok(PARENT_COMMANDS.includes(command), `the parent re-check does not run \`${command}\` -- it would answer a narrower question`);
  }
  assert.doesNotMatch(PARENT_COMMANDS, /\bp?npm test\b/, "`pnpm test` is `test:ts`, whose glob excludes packages/agent-org and packages/lab");
});

test("a parent that does not build is UNKNOWN, never a pass: the build's failure is not swallowed", () => {
  assert.match(PARENT_COMMANDS, /if ! pnpm run build[^\n]*; then[\s\S]*?result=unknown/);
  assert.doesNotMatch(PARENT_COMMANDS, /pnpm run build[^\n]*\|\| true/);
});

// --- 4. the policy asked for on the row, pinned ---

test("THE POLICY: other PRs keep merging onto a red main; the fix goes first by its ORDER; no queue jump is built", () => {
  assert.deepEqual({ ...RED_TRUNK_POLICY }, { othersKeepMerging: true, fixOrderIsFirst: true, fixPrJumpsQueue: false });
  const [o] = trunkRedOrders(red());
  assert.match(o.prompt, /Other pull requests KEEP MERGING/, "the order says what the policy is, so the fixer is not left to guess");
  assert.match(o.prompt, /outranks every other/);
});

// --- 5. nothing reverts ---

/** Every workflow file, and a positive control that there ARE some: an emptiness assertion over a walk that found nothing passes. */
const WORKFLOW_FILES = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

test("POSITIVE CONTROL: the workflow walk found the workflows, trunk.yml among them", () => {
  assert.ok(WORKFLOW_FILES.length >= 5, "the walk found too few workflows for an emptiness assertion over it to mean anything");
  assert.ok(WORKFLOW_FILES.includes("trunk.yml"));
});

// THE DELETED NAMES ARE SPELT IN PIECES, ON PURPOSE: the row's own open-check is a `git grep` for them over
// `.github packages docs` that must print nothing, and a test that named them whole would be the one thing it found.
const DELETED_SCRIPT = ["trunk-revert", ".mjs"].join("");
const DELETED_JOB = ["decide", "Revert"].join("");
const DELETED_NAMES = new RegExp(`${DELETED_SCRIPT.replace(".", "\\.")}|${DELETED_JOB}`);

test("POSITIVE CONTROL: the deleted-names pattern matches the names it spells in pieces, and not the guard beside them", () => {
  assert.ok(DELETED_NAMES.test(`run: node packages/agent-org/src/${DELETED_SCRIPT}`));
  assert.ok(DELETED_NAMES.test(`${DELETED_JOB}:`));
  assert.ok(!DELETED_NAMES.test("run: node packages/agent-org/src/trunk-revert-guard.mjs"),
    "the guard reverts nothing and is still wired -- matching it would make the walk below refuse trunk.yml");
});

test("NO WORKFLOW calls `git revert`, pushes or opens a `revert/` branch, or names the deleted script", () => {
  const offenders: string[] = [];
  for (const file of WORKFLOW_FILES) {
    // Comments are HISTORY and may name the retired thing; only what a step would RUN counts.
    const code = readFileSync(path.join(WORKFLOWS, file), "utf8").split("\n")
      .filter((line) => !/^\s*#/.test(line)).join("\n");
    if (/git\s+revert\b/.test(code)) offenders.push(`${file}: git revert`);
    if (/revert\/[\w$-]/.test(code)) offenders.push(`${file}: a revert/ branch`);
    if (/gh\s+pr\s+create[^\n]*revert/i.test(code)) offenders.push(`${file}: a revert pull request`);
    if (DELETED_NAMES.test(code)) offenders.push(`${file}: the deleted revert path`);
  }
  assert.deepEqual(offenders, []);
});

test("the revert script and its token test are GONE, and the guard that reverts nothing is still wired", () => {
  assert.ok(!existsSync(path.join(TOOL_SRC, DELETED_SCRIPT)));
  assert.ok(!existsSync(path.join(HOME_CHECKOUT, "packages/lab/src/packaging/trunk-revert-token.test.ts")));
  assert.ok(existsSync(path.join(TOOL_SRC, "trunk-revert-guard.mjs")),
    "despite the name it reverts nothing: it checks a push did not silently UNDO work already on main (#411)");
  assert.ok(existsSync(path.join(TOOL_SRC, "parent-recheck-summary.mjs")));
  const gate = (trunk.jobs.trunkGate.steps ?? []).map((s) => s.run ?? "").join("\n");
  assert.match(gate, /trunk-revert-guard\.mjs/);
});

test("no order a session can be handed tells it to revert -- only to NOT revert", () => {
  for (const r of [red(), red({ recheck: "fail", parentFailingTests: [TEST] }), red({ recheck: "unknown" }),
    red({ originPr: null, failedJobs: ["trunkGate"], failingTests: null })]) {
    const [o] = trunkRedOrders(r);
    const stripped = o.prompt.replace(/DO NOT REVERT|Nothing reverts a merge[^\n]*\n/g, "");
    assert.doesNotMatch(stripped.replace(/not `git revert`[^.]*\./g, ""), /\brevert (the|this) (merge|push)\b/i);
  }
});
