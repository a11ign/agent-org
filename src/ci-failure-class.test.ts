// #4632: a red check's failure class and route. A fake `fetch`, a fake `readKey`, a fake diagnostic and a state fixture only: no network, no real key, no corpus.
// no-token: gh -- nothing here calls `gh`; every dependency is injected, and what GitHub says (a red check and its log, the jobs, the incident rows, the pull requests a merged fix refreshes) is the fake code host's world (A11-160, step 9)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  CI_FAILURE_CLASSES, MAX_ERROR_LINES, classLine, classNote, classifyCiFailure, fallbackClass, readCiFailure, routeFor, trimErrorLines,
  SHARED_FAILURE_LABEL, holdSharedFailures, notedAs, readSignature, refreshFixed, sharedFailureGroups, sharedFailureTick, type CiFailure, type FailureSignature, type RedCheck, type CiFailureClass, type RedPr, type Run,
} from "./ci-failure-class.ts";
import { MAX_STATE_BYTES, type DecisionDeps } from "./decision-provider.ts";
import { parseHostConfig } from "./host-config.ts";
import { freshState } from "./triage-provider.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import type { FakeRowsWorld } from "./plugins/fakes/code-host-rows.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const withTriage = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: "/fake/key", minConfidence: 0.9 };

const failure = (over: Partial<CiFailure> = {}): CiFailure => ({
  errorLines: ["AssertionError [ERR_ASSERTION]: expected 3, got 4", "    at src/thing.test.ts:12"],
  redOnMain: false, redOnOtherPrs: false, readsOutsideRepository: false, rateLimitOrRunnerLost: false, rerunAlready: false,
  ...over,
});

type Reply = { status?: number; body?: unknown; throws?: boolean };
function fakeFetch(r: Reply) {
  const calls: { body: any }[] = [];
  const fn = (async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    if (r.throws) throw new Error("connection refused");
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const answer = (choice: string, confidence = 0.95) => ({ answers: { class: { type: "choice", choice, probabilities: {}, confidence } } });

function rig(opts: { triage?: unknown; on?: boolean; reply?: Reply; readKey?: (path: string) => string } = {}) {
  const net = fakeFetch(opts.reply ?? { body: answer("flaky") });
  const lines: string[] = [];
  const deps: DecisionDeps = {
    host: withTriage("triage" in opts ? opts.triage : JEV), fetch: net.fn, state: freshState(), timeoutMs: 50, diagnostic: (line) => lines.push(line),
    readKey: opts.readKey ?? (() => "FAKE-KEY"), switches: { "ci-failure-class": opts.on ?? true },
  };
  return { deps, net, lines };
}

test("the rule with no provider: red on main is another repository, a rate limit is infrastructure, everything else is the PR's own", () => {
  assert.equal(fallbackClass(failure()), "own-defect");
  assert.equal(fallbackClass(failure({ redOnMain: true })), "another-repository-changed");
  assert.equal(fallbackClass(failure({ rateLimitOrRunnerLost: true })), "infrastructure");
  // negative controls: a fact that is NOT the rule's trigger changes nothing
  assert.equal(fallbackClass(failure({ redOnOtherPrs: true, readsOutsideRepository: true, rerunAlready: true })), "own-defect");
  // a runner lost on main too is still not a repository that changed
  assert.equal(fallbackClass(failure({ redOnMain: true, rateLimitOrRunnerLost: true })), "infrastructure");
});

test("each class has its own route, and a flaky failure is rerun once and never a second time", () => {
  assert.deepEqual(CI_FAILURE_CLASSES.map((c) => routeFor(c, { rerunAlready: false })), ["owner", "rerun-once", "cross-repo-incident", "rerun-after-reset", "push-or-update-branch"]);
  assert.equal(routeFor("flaky", { rerunAlready: true }), "owner");
  // the already-rerun fact moves only the flaky class
  for (const c of CI_FAILURE_CLASSES.filter((k) => k !== "flaky")) assert.equal(routeFor(c, { rerunAlready: true }), routeFor(c, { rerunAlready: false }));
});

test("provider absent: no triage block, or provider none, asks nobody and takes the rule", async () => {
  for (const triage of [undefined, { provider: "none" }]) {
    const { deps, net, lines } = rig({ triage });
    const out = await classifyCiFailure(failure({ redOnMain: true }), deps);
    assert.deepEqual([out.klass, out.route, out.via, out.fellBack], ["another-repository-changed", "cross-repo-incident", "none", true]);
    assert.equal(net.calls.length, 0);
    assert.deepEqual(lines, []);
  }
});

test("key missing: the rule, no request, and one diagnostic that does not name the path", async () => {
  const { deps, net, lines } = rig({ readKey: () => { throw new Error("ENOENT /fake/key"); } });
  const out = await classifyCiFailure(failure({ rateLimitOrRunnerLost: true }), deps);
  assert.deepEqual([out.klass, out.via], ["infrastructure", "none"]);
  assert.equal(net.calls.length, 0);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\/fake\/key/);
});

test("use switched off: the rule, no request; the same inputs switched on ask the provider (the positive control)", async () => {
  const off = rig({ on: false });
  const offOut = await classifyCiFailure(failure(), off.deps);
  assert.deepEqual([offOut.klass, offOut.via, offOut.reason], ["own-defect", "none", "the use is switched off"]);
  assert.equal(off.net.calls.length, 0);
  const on = rig({ on: true });
  await classifyCiFailure(failure(), on.deps);
  assert.equal(on.net.calls.length, 1);
});

test("provider on: its class and route win, for each of the five classes (the fifth is offered only with its fact)", async () => {
  for (const klass of CI_FAILURE_CLASSES) {
    const { deps, net } = rig({ reply: { body: answer(klass) } });
    const out = await classifyCiFailure(failure({ staleMergeRef: true }), deps);
    assert.deepEqual([out.klass, out.route, out.via, out.fellBack, out.confidence], [klass, routeFor(klass, { rerunAlready: false }), "jev", false, 0.95]);
    assert.equal(net.calls.length, 1);
  }
});

test("provider on: the request carries the trimmed state and the four criteria (five with the stale-merge-ref fact), and never an agent-written body", async () => {
  const { deps, net } = rig();
  await classifyCiFailure(failure({ redOnOtherPrs: true }), deps);
  const sent = net.calls[0].body;
  assert.deepEqual(Object.keys(sent.state).sort(), ["errorLines", "readsOutsideRepository", "rateLimitOrRunnerLost", "redOnMain", "redOnOtherPrs"].sort());
  assert.equal(sent.state.redOnOtherPrs, true);
  assert.deepEqual(Object.keys(sent.questions.class.criteria), CI_FAILURE_CLASSES.filter((klass) => klass !== "stale-merge-ref"));
});

test("a flaky answer on a run already rerun routes to the owner and keeps the class", async () => {
  const { deps } = rig({ reply: { body: answer("flaky") } });
  const out = await classifyCiFailure(failure({ rerunAlready: true }), deps);
  assert.deepEqual([out.klass, out.route], ["flaky", "owner"]);
});

test("every way the provider can fail takes the rule: a refusal, a timeout, a thrown fetch, a malformed answer, a class that is none, a confidence under the floor", async () => {
  const cases: Record<string, Reply> = {
    refusal: { status: 403, body: {} },
    thrown: { throws: true },
    malformed: { body: { answers: { class: "flaky" } } },
    "not a class": { body: answer("a-fifth-class") },
    "under the floor": { body: answer("flaky", 0.89) },
  };
  for (const [name, reply] of Object.entries(cases)) {
    const { deps } = rig({ reply });
    const out = await classifyCiFailure(failure({ redOnMain: true }), deps);
    assert.deepEqual([out.klass, out.fellBack], ["another-repository-changed", true], name);
  }
  // the floor is the boundary: 0.9 is taken, 0.89 above is not
  const atFloor = await classifyCiFailure(failure({ redOnMain: true }), rig({ reply: { body: answer("flaky", 0.9) } }).deps);
  assert.deepEqual([atFloor.klass, atFloor.fellBack], ["flaky", false]);
});

test("trimming: at most 40 non-blank lines, colour codes stripped, each line cut, and the state fits the seam's limit", () => {
  const long = Array.from({ length: 100 }, (_, i) => `\u001b[31mline ${i}\u001b[0m ${"x".repeat(500)}`);
  const kept = trimErrorLines(["", "   ", ...long]);
  assert.ok(kept.length > 0 && kept.length <= MAX_ERROR_LINES);
  assert.ok(kept.every((l) => l.length <= 160 && !l.includes("\u001b")));
  assert.ok(kept[0].startsWith("line 0"));
  assert.ok(Buffer.byteLength(JSON.stringify({ errorLines: kept })) < MAX_STATE_BYTES);
  // the line cap binds on its own when the lines are short enough for the byte budget not to
  assert.equal(trimErrorLines(Array.from({ length: 100 }, (_, i) => `e${i}`)).length, MAX_ERROR_LINES);
  // negative control: a short, clean input is kept whole and in order
  assert.deepEqual(trimErrorLines(["a", "b"]), ["a", "b"]);
});

test("a huge error is trimmed to fit, so the provider is still asked rather than falling back on size", async () => {
  const { deps, net } = rig();
  const out = await classifyCiFailure(failure({ errorLines: Array.from({ length: 500 }, () => "y".repeat(400)) }), deps);
  assert.equal(net.calls.length, 1);
  assert.equal(out.via, "jev");
});

test("the line the order and the log carry names the class, the route and who chose", async () => {
  const rule = await classifyCiFailure(failure({ rateLimitOrRunnerLost: true }), rig({ on: false }).deps);
  assert.match(classLine(rule), /^CI failure class: infrastructure -> rerun-after-reset \(rule: the use is switched off\)$/);
  const jev = await classifyCiFailure(failure(), rig({ reply: { body: answer("flaky") } }).deps);
  assert.equal(classLine(jev), "CI failure class: flaky -> rerun-once (provider)");
});

test("the classes are the four the first row named and the one #1524 added", () => {
  const names: CiFailureClass[] = ["own-defect", "flaky", "another-repository-changed", "infrastructure", "stale-merge-ref"];
  assert.deepEqual([...CI_FAILURE_CLASSES], names);
});

// ---- the job log (#767) -------------------------------------------------------------------------------------

const SHA = "abcdef12".padEnd(40, "0");
const NOW = Date.parse("2026-10-10T12:00:00Z");
const ESC = "\u001b";
const PR = { repo: "o/r", number: 77, head8: "abcdef12" };

/** The runner the live tool hands the code host's operations. The fake acts on its world and never calls it, so it throws if it ever is. */
const NO_GH: Run = () => { throw new Error("the fake code host runs nothing"); };

/** The fake code host in place, and its world. */
function codeHost(): FakeRowsWorld {
  const host = createFakeCodeHost();
  substituteCodeHost(host);
  return host.rowsWorld;
}

/** The fake code host in place with the red check of pull request #77 of o/r at `SHA`: a workflow run of `attempt` attempts, and a job whose log is `log`. What `readCiFailure` reads of GitHub is this. */
function redLog(log: string, attempt = 1): Run {
  codeHost().tail.classes.failingChecksOf.set("o/r#77", { headSha: SHA, read: { branch: "agent/x-77", workflow: "CI", runAttempt: attempt, log } });
  return NO_GH;
}

// The command a log is read with (`--allow-escape-sequences`, which `gh api` needs to print a coloured log at all) and how the red check is picked out of the checks are the plugin's
// (`plugins/github/rows/class-ci-reads.test.ts`); here the log arrives as the code host read it, colour codes in it, and what this file does with it is asserted.

test("a coloured job log is read, and its coloured `##[error]` line matches as the plain line it is", () => {
  const log = [
    `${ESC}[36;1m##[group]Run pnpm test${ESC}[0m`,
    `${ESC}[?25lError: cursor-hidden line${ESC}[?25h`,
    `${ESC}[31;1m##[error]${ESC}[0mProcess completed with exit code 1.`,
    `${ESC}[31mAssertionError${ESC}[0m [ERR_ASSERTION]: expected 3, got 4`,
    "",
  ].join("\n");
  const out = readCiFailure(PR, redLog(log), NOW);
  assert.ok(out !== null);
  assert.deepEqual(out.errorLines, ["Error: cursor-hidden line", "##[error]Process completed with exit code 1.", "AssertionError [ERR_ASSERTION]: expected 3, got 4"]);
  assert.ok(out.errorLines.every((line) => !line.includes(ESC)));
});

test("escape bytes inside a phrase do not hide it from the fact that reads the whole log", () => {
  const out = readCiFailure(PR, redLog(`API rate ${ESC}[1mlimit${ESC}[0m exceeded for user\n`), NOW);
  assert.ok(out !== null);
  assert.equal(out.rateLimitOrRunnerLost, true);
  // negative control: the same log with nothing in it that is a rate limit says so
  assert.equal(readCiFailure(PR, redLog(`${ESC}[1mAssertionError${ESC}[0m: nope\n`), NOW)!.rateLimitOrRunnerLost, false);
});

test("a log with no escape bytes is read as before: the same lines, nothing stripped or lost", () => {
  const out = readCiFailure(PR, redLog("setup\nAssertionError: expected 1 to equal 2\nnot ok 1 - the thing\n"), NOW);
  assert.ok(out !== null);
  assert.deepEqual(out.errorLines, ["AssertionError: expected 1 to equal 2", "not ok 1 - the thing"]);
  assert.equal(out.rateLimitOrRunnerLost, false);
});

test("a red check is read to its facts: the rerun count, and the same failure red on main or on other branches 'at the same time'", () => {
  const world = codeHost();
  world.tail.classes.failingChecksOf.set("o/r#77", { headSha: SHA, read: { branch: "agent/x-77", workflow: "CI", runAttempt: 2, log: "AssertionError: nope\n" } });
  const iso = (ago: number) => new Date(NOW - ago).toISOString();
  const HOUR = 3_600_000;
  const quiet = readCiFailure(PR, NO_GH, NOW)!;
  assert.deepEqual([quiet.rerunAlready, quiet.redOnMain, quiet.redOnOtherPrs], [true, false, false], "a second attempt was already rerun; nothing else is red");
  world.tail.classes.recentRuns.onMain = [{ name: "CI", conclusion: "failure", headBranch: "main", updatedAt: iso(HOUR) }, { name: "CI", conclusion: "success", headBranch: "main", updatedAt: iso(2 * HOUR) }];
  world.tail.classes.recentRuns.failingForPullRequests = [{ name: "CI", conclusion: "failure", headBranch: "agent/y-78", updatedAt: iso(HOUR) }];
  const red = readCiFailure(PR, NO_GH, NOW)!;
  assert.deepEqual([red.redOnMain, red.redOnOtherPrs], [true, true]);
  // the newest run of the workflow on main decides, and a run older than six hours is a different failure
  world.tail.classes.recentRuns.onMain = [{ name: "CI", conclusion: "success", headBranch: "main", updatedAt: iso(HOUR) }, { name: "CI", conclusion: "failure", headBranch: "main", updatedAt: iso(2 * HOUR) }];
  world.tail.classes.recentRuns.failingForPullRequests = [{ name: "CI", conclusion: "failure", headBranch: "agent/y-78", updatedAt: iso(7 * HOUR) }, { name: "CI", conclusion: "failure", headBranch: "agent/x-77", updatedAt: iso(HOUR) }];
  const repaired = readCiFailure(PR, NO_GH, NOW)!;
  assert.deepEqual([repaired.redOnMain, repaired.redOnOtherPrs], [false, false], "a green run since is a repair; a stale run and the pull request's own branch are not 'other pull requests'");
});

test("a head that moved, or a red check that is not a workflow job, is no failure to classify, and a refused read is not 'not red'", () => {
  const world = codeHost();
  world.tail.classes.failingChecksOf.set("o/r#77", { headSha: "f".repeat(40), read: { branch: "b", workflow: "CI", runAttempt: 1, log: "x" } });
  assert.equal(readCiFailure(PR, NO_GH, NOW), null, "the order names another head");
  world.tail.classes.failingChecksOf.set("o/r#77", { headSha: SHA, read: null });
  assert.equal(readCiFailure(PR, NO_GH, NOW), null, "nothing red at the head the order names");
  world.tail.classes.failingChecksOf.set("o/r#77", new Error("HTTP 502"));
  assert.throws(() => readCiFailure(PR, NO_GH, NOW), /HTTP 502/);
});

// ---------------------------------------------------------------------------------------------------
// a11ign#5008: a failure SHARED by open pull requests is one incident, and its merged fix refreshes them.

const INSTALL_ERROR = "2026-10-11T09:42:11.123Z ##[error]npm ERR! 404 Not Found - GET https://registry/agent-org-0.155.4.tgz";
type Job = { steps: { name: string; conclusion: string }[]; log: string };
const jobUrl = (job: number) => `https://github.com/a11ign/a11ign/actions/runs/${job + 1000}/job/${job}`;
const redPr = (number: number, job: number, check = "checks"): RedPr =>
  ({ ref: `pr-${number}`, repo: "a11ign/a11ign", number, checks: [{ name: check, detailsUrl: jobUrl(job), completedAt: "2026-10-11T09:50:00Z" }] });
const redOrder = (number: number) => ({ cause: "pr-checks-failing", subject: `pr-${number}`, session: `worker-${number}`, discriminator: "red" });

/** The step a job failed at, which is what the code host reads of a job's steps. */
const failedStepOf = (job: Job): string | null => job.steps.find((step) => step.conclusion === "failure")?.name ?? null;
const seedJobs = (world: FakeRowsWorld, jobs: Record<number, Job>): void => {
  for (const [id, job] of Object.entries(jobs)) world.tail.classes.jobs.set(id, { failedStep: failedStepOf(job), log: job.log });
};
/** The fake code host in place with `jobs` by job id: what the code host reads of the red checks' jobs. */
function ciWorld(jobs: Record<number, Job> = {}): FakeRowsWorld {
  const world = codeHost();
  seedJobs(world, jobs);
  return world;
}
const incidentsOf = (world: FakeRowsWorld) => [...world.rows.values()].filter((row) => row.labels.includes(SHARED_FAILURE_LABEL));
/** An open pull request of the project that is `behind` commits behind its base. */
function openBehind(world: FakeRowsWorld, refs: string[], { behind = 3, refuse = {} }: { behind?: number; refuse?: Record<string, string> } = {}): void {
  for (const ref of refs) world.tail.classes.refreshPulls.set(ref, { open: true, mergedAt: null, behindBy: behind, updateRefusal: refuse[ref] ?? null });
}
/** A CLOSED incident row whose closing pull request `fix` (in `a11ign/agent-org`) merged at `mergedAt` (null: it did not). */
function closedIncident(world: FakeRowsWorld, { number, body, fix, mergedAt }: { number: number; body: string; fix: number; mergedAt: string | null }): void {
  world.rows.set(number, fakeRow(world, number, { state: "CLOSED", body, labels: [SHARED_FAILURE_LABEL], closedAt: new Date(world.now()).toISOString() }));
  world.tail.classes.closedBy.set(number, [{ number: fix, repo: "a11ign/agent-org" }]);
  world.tail.classes.refreshPulls.set(`a11ign/agent-org#${fix}`, { open: false, mergedAt, behindBy: 0, updateRefusal: null });
}
const installJob = (): Job => ({ steps: [{ name: "Set up job", conclusion: "success" }, { name: "Install agent-org", conclusion: "failure" }], log: `${INSTALL_ERROR}\n` });
const log = () => {};

test("shared failure -- POSITIVE CONTROL: two open PRs fail the same setup step, so the gate files ONE incident and wakes ZERO workers", () => {
  const world = ciWorld({ 11: installJob(), 12: { ...installJob(), log: INSTALL_ERROR.replace("09:42:11", "09:43:50") + "\n" } });
  const out = sharedFailureTick([redOrder(4969), redOrder(4977)], { prs: [redPr(4969, 11), redPr(4977, 12)], run: NO_GH, log });
  assert.deepEqual(out.orders, [], "no worker is woken");
  assert.equal(out.held.length, 2);
  assert.equal(incidentsOf(world).length, 1, "one incident row");
  const [row] = incidentsOf(world);
  assert.match(row.body, /Shared-failure-prs: a11ign\/a11ign#4969, a11ign\/a11ign#4977/);
  assert.equal(row.onBoard, true, "and it is on the board (#5405)");
  // the next tick JOINS it: the same failure on a third PR edits the one row and files no second
  seedJobs(world, { 13: installJob() });
  const again = sharedFailureTick([redOrder(4969), redOrder(4977), redOrder(5001)], { prs: [redPr(4969, 11), redPr(4977, 12), redPr(5001, 13)], run: NO_GH, log });
  assert.deepEqual(again.orders, []);
  assert.equal(incidentsOf(world).length, 1);
  assert.match(incidentsOf(world)[0].body, /#5001/);
});

test("shared failure -- NEGATIVE CONTROL: a PR whose own diff fails is still woken as today, and writes nothing", () => {
  const own: Job = { steps: [{ name: "Run tests", conclusion: "failure" }], log: "AssertionError [ERR_ASSERTION]: expected 3, got 4\n" };
  const world = ciWorld({ 11: installJob(), 12: installJob(), 21: own });
  // the two shared PRs are held; the third fails `gate` at a different step with a different line, and is NOT in their group
  const out = sharedFailureTick([redOrder(4969), redOrder(4977), redOrder(5100)], { prs: [redPr(4969, 11), redPr(4977, 12), redPr(5100, 21)], run: NO_GH, log });
  assert.deepEqual(out.orders.map((o) => o.subject), ["pr-5100"]);
  // alone, the same own failure is nobody's incident: no read of a log, no row, the order unchanged
  const alone = ciWorld({ 21: own });
  const lone = sharedFailureTick([redOrder(5100)], { prs: [redPr(5100, 21)], run: NO_GH, log });
  assert.deepEqual(lone.orders, [redOrder(5100)]);
  assert.deepEqual([alone.rows.size, alone.labelsCreated], [0, []]);
  // two PRs red on the same check for DIFFERENT own reasons are not one incident either
  ciWorld({ 21: own, 22: { ...own, log: "AssertionError: a different test failed\n" } });
  assert.equal(holdSharedFailures([redOrder(1), redOrder(2)], { prs: [redPr(1, 21), redPr(2, 22)], run: NO_GH }).held.length, 0);
});

test("shared failure: a log that cannot be read, a hung check and a PR with a second red check are never held", () => {
  ciWorld({ 11: installJob() }); // job 12's read is refused
  assert.equal(holdSharedFailures([redOrder(1), redOrder(2)], { prs: [redPr(1, 11), redPr(2, 12)], run: NO_GH }).held.length, 0);
  ciWorld({ 11: installJob(), 12: installJob() });
  const hung = { ...redOrder(1), discriminator: "hung-check" };
  assert.deepEqual(holdSharedFailures([hung, redOrder(2)], { prs: [redPr(1, 11), redPr(2, 12)], run: NO_GH }).orders, [hung, redOrder(2)]);
  const second = { ...redPr(2, 12), checks: [...redPr(2, 12).checks, { name: "unit", detailsUrl: jobUrl(30) }] };
  const out = holdSharedFailures([redOrder(1), redOrder(2)], { prs: [redPr(1, 11), second], run: NO_GH });
  assert.deepEqual(out.orders.map((o) => o.subject), ["pr-2"]);
});

/** Four red PRs, each with its own install job, and the orders that hold them: the shared-failure tick reads these. */
function fourRedHolds() {
  const numbers = [4969, 4977, 5001, 5008];
  const world = ciWorld(Object.fromEntries(numbers.map((n, i) => [11 + i, installJob()])));
  const prs = numbers.map((n, i) => redPr(n, 11 + i));
  const orders = numbers.map(redOrder);
  return { world, prs, orders };
}

test("#1557 POSITIVE: an open, UNCLAIMED incident row 16 minutes old (the shape of #5228) holds its four red PRs, wakes none, and is named in the log", () => {
  const { world, prs, orders } = fourRedHolds();
  sharedFailureTick(orders, { prs, run: NO_GH, log }); // files the row now
  const logs: string[] = [];
  const later = sharedFailureTick(orders, { prs, run: NO_GH, log: (line) => logs.push(line), nowMs: Date.now() + 16 * 60_000 });
  assert.equal(incidentsOf(world).length, 1, "one row, not joined to a second");
  assert.deepEqual(later.orders, [], "no worker is woken for the row's failure at 16 minutes");
  assert.deepEqual(later.released, []);
  assert.equal(later.held.length, 4);
  assert.match(logs.join(""), new RegExp(`incident #${incidentsOf(world)[0].number} has been open 15 minutes with no claim`));
});

test("#1557 NEGATIVE: an incident row CLOSED by its fix releases its four held PRs at once, naming the row", () => {
  const { world, prs, orders } = fourRedHolds();
  sharedFailureTick(orders, { prs, run: NO_GH, log });
  const [row] = incidentsOf(world);
  row.state = "CLOSED";
  row.closedAt = new Date().toISOString();
  const after = sharedFailureTick(orders, { prs, run: NO_GH, log, nowMs: Date.now() + 60_000 });
  assert.equal(after.orders.length, 4, "the closed row's holds are over: each worker is told the failure is its own to read");
  assert.equal(after.released.length, 4);
  assert.ok(after.orders.every((o) => String((o as { prompt?: string }).prompt).includes(`SHARED-FAILURE HOLD RELEASED (#${row.number}: its incident row was closed)`)));
});

test("the fix refreshes its victims: merging the incident's PR updates both branches, once, with no worker turn", () => {
  const body = ["Check: checks", "First error line: npm ERR! # Not Found - GET https://registry/agent-org-#.#.#.tgz", "Shared-failure-prs: a11ign/a11ign#4969, a11ign/a11ign#4977"].join("\n");
  const world = ciWorld();
  closedIncident(world, { number: 4988, body, fix: 5004, mergedAt: "2026-10-11T10:32:00Z" });
  openBehind(world, ["a11ign/a11ign#4969", "a11ign/a11ign#4977"]);
  const out = refreshFixed({ run: NO_GH, log, nowMs: Date.parse("2026-10-11T10:33:00Z") });
  assert.deepEqual(out.refreshed, ["a11ign/a11ign#4969", "a11ign/a11ign#4977"]);
  assert.deepEqual(world.tail.classes.branchUpdates, ["a11ign/a11ign#4969", "a11ign/a11ign#4977"]);
  // stamped, so the next tick does it no more -- even with both branches behind again, which is all that else could stop it
  assert.match(String(world.rows.get(4988)!.body), /^Refreshed-at: /m);
  openBehind(world, ["a11ign/a11ign#4969", "a11ign/a11ign#4977"]);
  assert.deepEqual(refreshFixed({ run: NO_GH, log, nowMs: Date.parse("2026-10-11T10:50:00Z") }).refreshed, []);
  assert.equal(world.tail.classes.branchUpdates.length, 2, "and no branch was updated a second time");
});

test("the fix is not merged, or a PR is not behind, or the refresh is refused: nothing is updated, and a conflict is the worker's again", () => {
  const body = "Check: checks\nFirst error line: x\nShared-failure-prs: a11ign/a11ign#1, a11ign/a11ign#2";
  const unmerged = ciWorld();
  closedIncident(unmerged, { number: 7, body, fix: 5004, mergedAt: null });
  openBehind(unmerged, ["a11ign/a11ign#1", "a11ign/a11ign#2"]);
  assert.deepEqual(refreshFixed({ run: NO_GH, log }).refreshed, []);
  assert.deepEqual([unmerged.tail.classes.branchUpdates, unmerged.rows.get(7)!.body], [[], body], "nothing was updated and the row was not stamped");
  const upToDate = ciWorld();
  closedIncident(upToDate, { number: 7, body, fix: 5004, mergedAt: "2026-10-11T10:32:00Z" });
  openBehind(upToDate, ["a11ign/a11ign#1", "a11ign/a11ign#2"], { behind: 0 });
  assert.deepEqual(refreshFixed({ run: NO_GH, log }).refreshed, []);
  const conflict = ciWorld();
  closedIncident(conflict, { number: 7, body, fix: 5004, mergedAt: "2026-10-11T10:32:00Z" });
  openBehind(conflict, ["a11ign/a11ign#1", "a11ign/a11ign#2"], { refuse: { "a11ign/a11ign#2": "422 merge conflict" } });
  const out = refreshFixed({ run: NO_GH, log });
  assert.deepEqual([out.refreshed, out.refused], [["a11ign/a11ign#1"], ["a11ign/a11ign#2"]]);
  // the refused PR is released: its red order is delivered again instead of held
  seedJobs(conflict, { 11: installJob(), 12: installJob() });
  const tick = sharedFailureTick([redOrder(1), redOrder(2)], { prs: [redPr(1, 11), redPr(2, 12)], run: NO_GH, log });
  assert.deepEqual(tick.orders.map((o) => o.subject), ["pr-2"]);
});

test("the detector: a PR red before the fix merged, unnoted, is refreshed only 10 minutes after the merge", () => {
  const body = "Check: checks\nFirst error line: npm ERR! # Not Found - GET https://registry/agent-org-#.#.#.tgz\nShared-failure-prs: a11ign/a11ign#4969";
  const mk = () => {
    const world = ciWorld({ 12: installJob() });
    closedIncident(world, { number: 4988, body, fix: 5004, mergedAt: "2026-10-11T10:32:00Z" });
    openBehind(world, ["a11ign/a11ign#4969", "a11ign/a11ign#4977"]);
    return world;
  };
  mk();
  const early = refreshFixed({ run: NO_GH, log, nowMs: Date.parse("2026-10-11T10:35:00Z"), open: [redPr(4977, 12)] });
  assert.deepEqual(early.refreshed, ["a11ign/a11ign#4969"]);
  mk();
  const late = refreshFixed({ run: NO_GH, log, nowMs: Date.parse("2026-10-11T10:43:00Z"), open: [redPr(4977, 12)] });
  assert.deepEqual(late.refreshed, ["a11ign/a11ign#4969", notedAs(redPr(4977, 12))]);
});

// ---------------------------------------------------------------------------------------------------
// #5098: WHICH LINE IS THE FAILURE, and what is never a cause. The packaging test reaches these from the gate with the real control logs; these pin each rule ALONE, because
// the diff rule would also keep the same pair from being grouped and so hides a broken one beside it.

/** The fake code host in place with job 77: it failed at `failedStep` and its log is `log`. */
const jobRun = (failedStep: string, ...log: string[]): Run => {
  ciWorld({ 77: { steps: [{ name: failedStep, conclusion: "failure" }], log: log.join("\n") } });
  return NO_GH;
};
const checkOf = (name: string): RedCheck => ({ name, detailsUrl: jobUrl(77) });

test("#5098 a package manager's WARN line, a command echoed by the runner and the exit code are not the failure; a test runner's FAIL line is", () => {
  const warn = "2026-10-11T13:10:30Z  WARN  Failed to create bin at /home/runner/work/control/control/core/node_modules/.bin/a11ign. ENOENT";
  const echo = "2026-10-11T13:10:31Z ##[group]Run pnpm run fail-fast";
  const exit = "2026-10-11T13:13:31Z ##[error]Process completed with exit code 1.";
  const assertion = "2026-10-11T13:13:30Z AssertionError: the racing tick found the day reserved";
  assert.match(readSignature(checkOf("checks"), jobRun("Run tests", warn, echo, assertion, exit))!.line, /^AssertionError: the racing tick found the day reserved/);
  const fail = "2026-10-11T13:13:30Z  FAIL  packages/control/src/fleet-watch.test.ts > postUseOnce: a tick that lands";
  const out = readSignature(checkOf("checks"), jobRun("Run tests", warn, assertion, fail, exit))!;
  assert.match(out.line, /^FAIL\s+packages\/control\/src\/fleet-watch\.test\.ts > postUseOnce/);
  assert.equal(out.file, "packages/control/src/fleet-watch.test.ts");
});

test("#5098 the roll-up is no cause: by its name, by the step it fails, and by the line its script prints", () => {
  const install: FailureSignature = { check: "gate", step: "Install agent-org", line: "npm ERR!", file: null };
  const pr = (n: number, name: string): RedPr => ({ ref: `pr-${n}`, repo: "a11ign/a11ign", number: n, checks: [{ name, detailsUrl: jobUrl(n) }] });
  // by NAME: were `gate` a cause, two PRs failing it on a setup-looking step would be one incident
  assert.deepEqual(sharedFailureGroups([pr(1, "gate"), pr(2, "gate")], () => install), []);
  assert.equal(sharedFailureGroups([pr(1, "checks"), pr(2, "checks")], () => ({ ...install, check: "checks" })).length, 1, "positive control: the same pair on a real job IS grouped");
  // by STEP and by LINE, for a roll-up that is named something else
  assert.equal(readSignature(checkOf("ci-ok"), jobRun("Every job ran, and ran clean", "##[error]boom")), null);
  assert.equal(readSignature(checkOf("ci-ok"), jobRun("Every job that ran, ran clean", "##[error]boom")), null, "the other spelling of the roll-up step, as the row names it");
  assert.equal(readSignature(checkOf("ci-ok"), jobRun("Check results", "##[error]a job reported 'failure', not success")), null);
  assert.deepEqual(readSignature(checkOf("ci-ok"), jobRun("Check results", "##[error]boom"))?.line, "boom", "positive control: the same step and a real error is read");
});

test("a check whose address names no workflow job, or whose job has no failed step, or whose read is refused, has no signature", () => {
  const run = jobRun("Run tests", "##[error]boom");
  assert.equal(readSignature({ name: "checks", detailsUrl: "https://example.com/status/1" }, run), null, "no job to read");
  ciWorld({ 77: { steps: [{ name: "Run tests", conclusion: "success" }], log: "##[error]boom" } });
  assert.equal(readSignature(checkOf("checks"), NO_GH), null, "a job that failed at no step");
  ciWorld();
  assert.equal(readSignature(checkOf("checks"), NO_GH), null, "a refused read is unclassified, never 'shared'");
});

// ---------------------------------------------------------------------------------------------------
// agent-org#1524: a run that checked out a SUPERSEDED merge commit is not this pull request's defect. The commit has no parents, so the acceptance gate cannot read the diff; a rerun
// checks out that same commit again, so the route is to push or update the branch so GitHub builds a new one.

const STALE_LOG = [
  "ACCEPTANCE-SOURCE: none (the diff could not be read, so no file added under .acceptance/ was found and its author a11ign-workers[bot] is not exempt)",
  "MUTATION: UNCHECKED -- could not read the diff (the merge commit this run checked out is not a parent-bearing merge: re-push or update the branch; a rerun reuses it).",
].join("\n");

test("#1524 POSITIVE: an acceptance that could not read the diff is stale-merge-ref, routed to a push or an update of the branch, and the order says a rerun cannot clear it", async () => {
  const out = readCiFailure(PR, redLog(STALE_LOG), NOW);
  assert.equal(out?.staleMergeRef, true);
  assert.equal(fallbackClass(out!), "stale-merge-ref");
  assert.equal(routeFor("stale-merge-ref", { rerunAlready: false }), "push-or-update-branch");
  const decision = await classifyCiFailure(out!, rig({ triage: { provider: "none" } }).deps);
  assert.equal(decision.route, "push-or-update-branch");
  assert.match(classNote(decision), /a rerun reuses the same merge commit/);
});

test("#1524 NEGATIVE: a diff that was read and a test that failed is still the pull request's own defect, routed to its owner", () => {
  const out = readCiFailure(PR, redLog("FAIL  src/x.test.ts > adds\nAssertionError: expected 3, got 4\n"), NOW);
  assert.equal(out?.staleMergeRef, undefined, "absent, not false: the object is the one it was before #1524");
  assert.equal(fallbackClass(out!), "own-defect");
  assert.equal(routeFor("own-defect", { rerunAlready: false }), "owner");
});

test("#1524 the rule: stale-merge-ref comes after a lost runner and before main, and the provider is offered it only with its fact", async () => {
  assert.equal(fallbackClass(failure({ staleMergeRef: true })), "stale-merge-ref");
  assert.equal(fallbackClass(failure({ staleMergeRef: true, redOnMain: true })), "stale-merge-ref");
  assert.equal(fallbackClass(failure({ staleMergeRef: true, rateLimitOrRunnerLost: true })), "infrastructure");
  assert.equal(fallbackClass(failure({ staleMergeRef: false, redOnMain: true })), "another-repository-changed");
  const without = rig({ reply: { body: answer("stale-merge-ref") } });
  const out = await classifyCiFailure(failure(), without.deps);
  assert.ok(!Object.keys(without.net.calls[0].body.questions.class.criteria).includes("stale-merge-ref"));
  assert.equal(out.klass, "own-defect", "an answer outside the offered classes is the rule's");
  const withFact = rig({ reply: { body: answer("stale-merge-ref") } });
  assert.equal((await classifyCiFailure(failure({ staleMergeRef: true }), withFact.deps)).klass, "stale-merge-ref");
  assert.equal(withFact.net.calls[0].body.state.staleMergeRef, true);
});
