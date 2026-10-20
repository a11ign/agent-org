// no-token: gh -- `run` is a fake `gh` that answers from fixtures and records every call; nothing here spawns `gh`
/**
 * agent-org#1647: A NETWORK ERROR IN AN INSTALL STEP OF A MERGE-GROUP RUN IS INFRASTRUCTURE, AND THE GATE RE-QUEUES THE EJECTED PULL REQUEST ONCE.
 *
 * THE DEFECT, 2026-10-16: agent-org#1639 was approved and green, and the queue ejected it because the merge group's `typecheck` job failed in its install on `npm error code ECONNRESET` (run 38936509518).
 * That job names no file, so the ownership was `unknown`, the ejection stayed the owner's, and `arm-pr` refused to re-arm without a push: about two hours until a person armed it by hand.
 *
 * Every case is reached from `readArmingOf`, the call the tick makes, with the real timeline, run list and `--log-failed` shapes behind a fake `gh` (the log below is that run's own shape: the step's
 * lines end `A complete log of this run can be found in`, so the error line is NOT the last one). The row's cases, each with its control:
 *   (1) the install log is re-queued once (control: the flag OFF, or only the older flag on, leaves it the owner's);
 *   (2) the same log on a head already re-queued once is NOT (control: the first entry is);
 *   (3) a log that names a file the pull request changes is still the owner's (control: the unrelated file, with the flag on, is not infrastructure either);
 *   (4) a log with no recognised signature is still `unknown` (control: the same step with ECONNRESET is re-queued; and ECONNRESET in a step that is NOT an install is not infrastructure);
 *   (5) with the flag OFF nothing is read or written (the world's `gh` throws if asked).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyCanaryState, machineryFlagOn, STANDARD_MACHINERY_SIGNALS } from "../org-health/fleet-build-readings.ts";
import { machineryValues, withMachineryFlag } from "../org-health.ts";
import { MACHINERY_SIGNALS } from "../org-health/hold-and-rerun-readings.ts";
import { FLAG_REGISTRY } from "../machinery-flag.ts";
import { REENQUEUE_EJECTED_FLAG, REENQUEUE_INFRA_FLAG, jobFailuresOf, ownershipOfFailure, requeueEjected, type EjectionEvidence } from "../work-gate/causes/pr-ejected.ts";
import { readArmingOf } from "../work-gate/tick/tick-decisions-and-flags.ts";
import { type ArmingPort } from "../work-gate/vocabulary.ts";
import yaml from "yaml";

const HOME = "a11ign/agent-org";
const NUMBER = 1639;
const NOW = Date.parse("2026-10-16T17:10:00Z");
const REMOVED_AT = "2026-10-16T17:04:30Z";
const INSTALL_STEP = "Install the dev dependencies the program imports types from (typescript, @types/node, yaml)";

const INFRA_ON = withMachineryFlag(emptyCanaryState(), { name: REENQUEUE_INFRA_FLAG, on: true });
const EJECTED_ONLY_ON = withMachineryFlag(emptyCanaryState(), { name: REENQUEUE_EJECTED_FLAG, on: true });
const BOTH_ON = withMachineryFlag(INFRA_ON, { name: REENQUEUE_EJECTED_FLAG, on: true });
const OFF = emptyCanaryState();

// --- the logs: `gh run view --log-failed`, one `job\tstep\tline` per line -------------------------------------------------------------------------

const row = (job: string, step: string, line: string) => `${job}\t${step}\t2026-10-16T17:02:05.2013948Z ${line}`;
const ROLL_UP = row("gate", "The suite, the typecheck, the changeset check and the release dry run all succeeded", "##[error]a job reported 'failure', not success");

/** The real run's install failure, in its own order: the signature is at the top and the step ends on the log pointer and the exit line. */
const installFailure = (signature: string[] = ["npm error code ECONNRESET", "npm error syscall read", "npm error errno -104", "npm error network read ECONNRESET"], step = INSTALL_STEP, job = "typecheck") => [
  ...signature.map((line) => row(job, step, line)),
  row(job, step, "npm error network This is a problem related to network connectivity."),
  row(job, step, "npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-10-16T17_02_00_000Z-debug-0.log"),
  row(job, step, "##[error]Process completed with exit code 152."),
  ROLL_UP,
].join("\n");

/** A test job failing in the file its TAP location names. */
const testFailure = (file: string) => [
  row("ts", "Test", "not ok 812 - a test that fails"),
  row("ts", "Test", "  ---"),
  row("ts", "Test", `  location: '/home/runner/work/agent-org/agent-org/${file}:50:1'`),
  ROLL_UP,
].join("\n");

const NETWORK_LOG = installFailure();
const REGISTRY_LOG = installFailure(["npm error code E503", "npm error 503 Service Unavailable - GET https://registry.npmjs.org/yaml"]);
const NO_SIGNATURE_LOG = installFailure(["npm error code E404", "npm error 404 Not Found - GET https://registry.npmjs.org/no-such-package"]);
const NETWORK_OUTSIDE_INSTALL_LOG = [row("ts", "Test", "not ok 3 - fetches the registry"), row("ts", "Test", "  error: read ECONNRESET"), ROLL_UP].join("\n");

// --- the world ------------------------------------------------------------------------------------------------------------------------------

type World = { log?: string; changed?: string[]; entries?: number; groups?: { head_branch: string; conclusion: string | null; created_at: string }[]; armRefused?: boolean; };

const QUEUE_EVENTS = (entries: number) => Array.from({ length: entries }, (_, at) => [
  { __typename: "AddedToMergeQueueEvent", createdAt: `2026-10-16T16:${10 + at * 20}:00Z` },
  { __typename: "RemovedFromMergeQueueEvent", createdAt: at === entries - 1 ? REMOVED_AT : `2026-10-16T16:${30 + at * 20}:00Z`, reason: "failed_checks" },
]).flat();

function fakeGh(world: World = {}) {
  const calls: string[][] = [];
  let armed = false;
  const run = (args: string[]): string => {
    calls.push(args);
    const line = args.join(" ");
    if (args[0] === "api" && args[1] === "graphql" && line.includes("timelineItems")) return JSON.stringify({ mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: "PullRequestCommit" }, ...QUEUE_EVENTS(world.entries ?? 1)] } });
    if (args[0] === "api" && args[1] === "graphql" && line.includes("-F n=")) return JSON.stringify({ merged: false, autoMergeRequest: armed && world.armRefused !== true ? { enabledAt: "now" } : null, mergeQueueEntry: null });
    if (args[0] === "api" && args[1] === "graphql") return JSON.stringify([{ number: NUMBER, isDraft: false, merged: false, autoMergeRequest: null, mergeQueueEntry: null }]);
    // THE QUEUE'S NEWEST GROUP IS RED by default: the network case must not wait for a green one, which answers "is main fixed" and a dropped connection broke nothing on main.
    if (/actions\/runs\?event=merge_group/.test(line)) return JSON.stringify([{ id: 38936509518, head_branch: `gh-readonly-queue/main/pr-${NUMBER}-ccc`, conclusion: "failure", created_at: "2026-10-16T17:02:00Z" }, ...(world.groups ?? RED_AFTER)]);
    if (args[0] === "run" && args[1] === "view") return world.log ?? NETWORK_LOG;
    if (args[0] === "pr" && args[1] === "merge") { armed = true; return ""; }
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ blockedBy: { nodes: [], totalCount: 0 } });
    throw new Error(`fake gh: unexpected ${line.slice(0, 120)}`);
  };
  return { run, calls };
}

const RED_AFTER = [{ head_branch: "gh-readonly-queue/main/pr-1700-ddd", conclusion: "failure", created_at: "2026-10-16T17:06:00Z" }];

function fakePort() {
  const comments: { kind: string; text: string }[] = [];
  const portFor = (): ArmingPort => ({
    armMerge() { throw new Error("the code-host port's arm runs arm-pr, which refuses an ejected PR: the re-queue must not go through it"); },
    postDecision(_ref, decision) { comments.push({ kind: decision.kind, text: decision.text }); return "1"; },
  });
  return { portFor, comments };
}

const prOf = (changed: string[] = ["src/unrelated.ts"]) => ({
  number: NUMBER, isDraft: false, labels: [], reviewDecision: "APPROVED", headRefOid: "deadbeef", body: "Closes: none -- test", files: changed.map((path) => ({ path })), changedFiles: changed.length, comments: [],
  statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
});

function tick(world: World = {}, state: ReturnType<typeof emptyCanaryState> = INFRA_ON) {
  const gh = fakeGh(world);
  const port = fakePort();
  const said: string[] = [];
  const arming = readArmingOf([prOf(world.changed)], ["gate"], { scope: HOME, run: gh.run, portFor: port.portFor, env: {}, log: (line) => said.push(line), state, now: NOW });
  assert.ok(arming !== null, "the stubbed reads answer");
  return { arming, gh, port, said: said.join("") };
}

const armCalls = (gh: ReturnType<typeof fakeGh>) => gh.calls.filter((c) => c[0] === "pr" && c[1] === "merge");

// --- (1) re-queued once -----------------------------------------------------------------------------------------------------------------------

test("an install step that ends `npm error code ECONNRESET` is re-queued once by the gate, and no owner is woken", () => {
  const { arming, gh, port, said } = tick();
  assert.equal(arming.ejections.size, 0, "it left the ejected set: nobody is told to fix what is not theirs");
  assert.deepEqual(arming.networkNotRequeued, [], "and the detector has nothing to say");
  assert.deepEqual(armCalls(gh), [["pr", "merge", String(NUMBER), "--repo", HOME, "--auto", "--merge"]], "armed once, by the gate, the way the org merges");
  assert.deepEqual(port.comments.map((c) => c.kind), ["pr-ejected-requeued"]);
  assert.match(port.comments[0].text, /install step of `typecheck` failed on the network or the registry \(npm error code ECONNRESET\)/);
  assert.match(port.comments[0].text, /flag `queue\.reenqueueInfra`/);
  assert.match(said, /pr-ejected-requeued: re-armed #1639 -- the install step of `typecheck`/);
});

test("a registry 5xx in the install step is infrastructure too, and a registry 404 is not", () => {
  assert.equal(tick({ log: REGISTRY_LOG }).arming.ejections.size, 0, "503 Service Unavailable: re-queued");
  const missing = tick({ log: NO_SIGNATURE_LOG });
  assert.equal(missing.arming.ejections.size, 1, "404 Not Found is the package's own fault, not the registry's blip");
  assert.deepEqual(armCalls(missing.gh), []);
});

test("CONTROL: the same ejection with the flag off, or with only the older flag on, stays the owner's", () => {
  for (const state of [OFF, EJECTED_ONLY_ON]) {
    const kept = tick({}, state);
    assert.deepEqual([...kept.arming.ejections.keys()], [NUMBER]);
    assert.deepEqual(armCalls(kept.gh), []);
    assert.deepEqual(kept.port.comments, []);
  }
});

// --- (2) the bound ----------------------------------------------------------------------------------------------------------------------------

test("the same log on a head the gate already re-queued once is NOT re-queued, and the detector names it with the error line", () => {
  const second = tick({ entries: 2 });
  assert.deepEqual([...second.arming.ejections.keys()], [NUMBER], "the second failed_checks on this head is the owner's");
  assert.deepEqual(armCalls(second.gh), []);
  assert.deepEqual(second.arming.networkNotRequeued.map(({ number, at, line }) => ({ number, at, line })), [{ number: NUMBER, at: Date.parse(REMOVED_AT), line: "npm error code ECONNRESET" }]);
  assert.match(second.said, /ejected-network-not-requeued: #1639 .*\(npm error code ECONNRESET\).*gate re-queues once/);
  // THE CONTROL: the first entry on the head is re-queued, so the bound is the only difference.
  assert.equal(tick({ entries: 1 }).arming.ejections.size, 0);
});

// --- (3) a file in the diff is the owner's -----------------------------------------------------------------------------------------------------

test("a log that names a file in the pull request's diff is still the owner's, even beside a network failure", () => {
  const own = tick({ log: testFailure("src/work-gate/causes/pr-ejected.ts"), changed: ["src/work-gate/causes/pr-ejected.ts"] });
  assert.deepEqual([...own.arming.ejections.keys()], [NUMBER]);
  assert.deepEqual(armCalls(own.gh), []);
  assert.deepEqual(own.arming.networkNotRequeued, [], "not a network failure, so not the detector's");
  // A job that fails on the network beside a job that fails in the PR's own file: the own one decides.
  const mixed = tick({ log: `${installFailure()}\n${testFailure("src/ci-failure-class.ts")}`, changed: ["src/ci-failure-class.ts"] });
  assert.deepEqual([...mixed.arming.ejections.keys()], [NUMBER]);
  assert.deepEqual(armCalls(mixed.gh), []);
  // THE CONTROL: the same two jobs with a diff that does not hold the file are NOT all infrastructure (one names a file), so still not re-queued by this flag...
  const outside = tick({ log: `${installFailure()}\n${testFailure("src/ci-failure-class.ts")}`, changed: ["README.md"] });
  assert.deepEqual(armCalls(outside.gh), [], "...but the file-naming job is not the network's");
  // ...and the install log alone, on the unrelated diff, is re-queued.
  assert.equal(tick({ changed: ["README.md"] }).arming.ejections.size, 0);
});

// --- (4) no recognised signature is unknown -----------------------------------------------------------------------------------------------------

test("a log with no recognised signature is still `unknown`, and a network word outside an install step is not infrastructure", () => {
  const none = tick({ log: NO_SIGNATURE_LOG }, BOTH_ON); // both flags, so the decider speaks: with only the infra flag it leaves a non-network ejection silently as today
  assert.equal(none.arming.ejections.size, 1);
  assert.match(none.said, /names no file the failure is in/);
  assert.deepEqual(none.arming.networkNotRequeued, []);
  const failures = jobFailuresOf(NETWORK_OUTSIDE_INSTALL_LOG);
  assert.equal(failures.some((failure) => failure.network !== undefined), false, "ECONNRESET in the Test step: a test that fetches, not an install");
  const test = tick({ log: NETWORK_OUTSIDE_INSTALL_LOG });
  assert.equal(test.arming.ejections.size, 1);
  assert.deepEqual(armCalls(test.gh), []);
  // THE CONTROL: the install step that does say ECONNRESET is re-queued (the first test), so the step's name is what separates them.
  assert.equal(jobFailuresOf(installFailure()).find((failure) => failure.job === "typecheck")?.network, "npm error code ECONNRESET");
  assert.equal(jobFailuresOf(installFailure(undefined, "Run the suite")).some((failure) => failure.network !== undefined), false, "the same lines under a step that is not an install");
});

// --- (5) off reads and writes nothing -----------------------------------------------------------------------------------------------------------

test("with the flag OFF the decider reads nothing and writes nothing; the detector still counts, from the log the tick already holds", () => {
  const evidence = new Map<number, EjectionEvidence>([[NUMBER, { failedEntries: 1, log: NETWORK_LOG, runs: RED_AFTER }]]);
  const calls: string[][] = [];
  const port = fakePort();
  const outcome = requeueEjected(new Map([[NUMBER, { removedAt: REMOVED_AT, runId: 1, failingTests: null }]]), {
    prs: [prOf()], scope: HOME, run: (args) => { calls.push(args); throw new Error("the decider asked gh while the flag is off"); }, portFor: port.portFor, state: OFF, now: NOW, log: () => {}, evidence,
  });
  assert.deepEqual(calls, [], "no read, no arm");
  assert.deepEqual(port.comments, [], "no record");
  assert.equal(outcome.remaining.size, 1, "the ejection comes back whole");
  assert.deepEqual([outcome.requeued, outcome.stranded], [[], []]);
  assert.equal(outcome.networkNotRequeued.length, 1, "the detector's reading: this one is the owner's although the install lost its connection");
  assert.equal(outcome.networkNotRequeued[0].line, "npm error code ECONNRESET");
  // THE CONTROL: the same call with the flag on arms, so the flag is the only difference.
  const on = requeueEjected(new Map([[NUMBER, { removedAt: REMOVED_AT, runId: 1, failingTests: null }]]), {
    prs: [prOf()], scope: HOME, run: fakeGh().run, portFor: fakePort().portFor, state: INFRA_ON, now: NOW, log: () => {}, evidence,
  });
  assert.deepEqual(on.requeued, [NUMBER]);
  assert.deepEqual(on.networkNotRequeued, []);
});

test("an arm that does not read back as armed is the owner's AND is counted by the detector", () => {
  const refused = tick({ armRefused: true });
  assert.equal(refused.arming.ejections.size, 1);
  assert.deepEqual(refused.port.comments, [], "no record of a re-queue that did not land, and the stranding clock (15 min) has not run: it is 5 minutes on");
  assert.equal(refused.arming.networkNotRequeued.length, 1);
  assert.match(refused.said, /does not read as armed/);
});

// --- the pure parts, each alone ------------------------------------------------------------------------------------------------------------------

test("ownershipOfFailure: infrastructure needs EVERY failing job to be an install on the network, and own outranks it", () => {
  const network = { job: "typecheck", file: null, network: "npm error code ECONNRESET" };
  const infra = ownershipOfFailure({ failures: [network], changed: ["a.ts"] });
  assert.deepEqual([infra.kind, infra.line], ["infrastructure", "npm error code ECONNRESET"]);
  assert.equal(ownershipOfFailure({ failures: [network, { job: "ts", file: null }], changed: ["a.ts"] }).kind, "unknown", "one job with no signature keeps the whole unknown");
  assert.equal(ownershipOfFailure({ failures: [network, { job: "ts", file: "a.ts" }], changed: ["a.ts"] }).kind, "own");
  assert.equal(ownershipOfFailure({ failures: [network], changed: null }).kind, "unknown", "a diff that could not be listed whole proves nothing");
  assert.equal(ownershipOfFailure({ failures: [{ job: "typecheck", file: null }], changed: ["a.ts"] }).kind, "unknown");
});

test("the flag is registered, OFF when absent, and the signal is one the tick records and the canary may watch", () => {
  assert.ok(FLAG_REGISTRY.includes(REENQUEUE_INFRA_FLAG), "`machinery:flag on queue.reenqueueInfra` is accepted, not refused as a flag no module reads");
  assert.equal(REENQUEUE_INFRA_FLAG, "queue.reenqueueInfra");
  assert.equal(machineryFlagOn(emptyCanaryState(), REENQUEUE_INFRA_FLAG), false);
  assert.equal(machineryFlagOn(INFRA_ON, REENQUEUE_INFRA_FLAG), true);
  assert.equal(MACHINERY_SIGNALS.EJECTED_NETWORK_NOT_REQUEUED, "ejected-network-not-requeued");
  assert.ok(STANDARD_MACHINERY_SIGNALS.includes("ejected-network-not-requeued"));
});

test("ejected-network-not-requeued counts the removals in the tick's window, and is null (unread) when the arming read was refused", () => {
  const facts = (ejectedNetwork: number[] | null) => ({ claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, ejectedNetwork });
  const read = (ejectedNetwork: number[] | null) => machineryValues({ facts: facts(ejectedNetwork), since: NOW - 60_000, now: NOW, memo: {} }).values[MACHINERY_SIGNALS.EJECTED_NETWORK_NOT_REQUEUED];
  assert.equal(read([NOW - 30_000, NOW - 10_000]), 2);
  assert.equal(read([NOW - 3_600_000]), 0, "a removal from before the window was counted by the tick that held it");
  assert.equal(read([]), 0);
  assert.equal(read(null), null, "not read is not zero");
  assert.equal(machineryValues({ facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null }, since: NOW - 60_000, now: NOW, memo: {} }).values[MACHINERY_SIGNALS.EJECTED_NETWORK_NOT_REQUEUED], null, "a caller that passes none leaves it unread");
});

// --- the workflow -------------------------------------------------------------------------------------------------------------------------

test("ci.yml retries every install's fetches, with the count named in the comment, and no job overrides it", () => {
  const text = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = yaml.parse(text);
  const retries = workflow.env?.npm_config_fetch_retries;
  assert.equal(typeof retries, "number");
  assert.ok(retries > 2, "above npm's default of 2, or it changes nothing");
  assert.match(text, new RegExp(`RETRIES A FAILED FETCH ${retries} TIMES \\(agent-org#1647\\)`), "the comment names the same count the setting holds");
  for (const [name, job] of Object.entries<any>(workflow.jobs)) {
    assert.equal(job.env?.npm_config_fetch_retries, undefined, `job ${name} must not override the workflow's count`);
    for (const step of job.steps ?? []) assert.equal(step.env?.npm_config_fetch_retries, undefined, `a step of ${name} must not override it`);
  }
  const installs = Object.values<any>(workflow.jobs).flatMap((job) => job.steps ?? []).filter((step: any) => /\b(npm install|pnpm install|npx pnpm)/.test(String(step.run ?? "")));
  assert.ok(installs.length >= 4, "this must not pass by finding no install step to cover");
});
