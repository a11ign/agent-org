// no-token: gh -- `run` is a fake `gh` that answers from fixtures and records every call; nothing here spawns `gh`
/**
 * a11ign#5125: A PULL REQUEST THE MERGE QUEUE EJECTED FOR A FAILURE THAT IS NOT ITS OWN IS RE-QUEUED BY THE GATE, ONCE, WHEN THE NEWEST MERGE GROUP IS GREEN.
 *
 * THE DEFECT, 2026-10-11: a11ign#5115, #5122 and #5124 were ejected (`failed_checks`) by one test that reads the world (`docs-release-pin-currency.real-tree.test.ts`: the newest release),
 * `main` was green again within the hour, and nothing re-queued them: auto-merge is cleared on ejection, so they sat approved, clean and unarmed until a person armed them by hand.
 *
 * Every case is reached from `readArmingOf`, the call the tick makes, with the real timeline, run list and `--log-failed` shapes behind a fake `gh`; the orders are the real ones (`stalledPrOrders`).
 * The row's named cases are the first two tests:
 *   (1) the #5124 shape (ejected by the pin guard, diff unrelated) is re-queued once `main` is green;
 *   (2) a PR ejected by its own test wakes its holder with the failing test.
 * The third (the pin guard skips a PR that touches no pinned doc) is NOT here: it is a property of a11ign/a11ign's own file, `packages/guards/src/docs-release-pin-currency.real-tree.test.ts`
 * (`scopeOf`'s named cases), and runs in that repository's suite. Reading that file from here would grep a sibling checkout's source, and this host's checkout is `main`, which does not
 * hold the change until it merges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyCanaryState } from "../org-health/fleet-build-readings.ts";
import { withMachineryFlag } from "../org-health.ts";
import { CLOSED_UNDER_HALF_FILE, CLOSED_UNDER_HALF_FLAG, closedUnderHalfOrders, rowsClosedUnderOpenHalf } from "../work-gate/causes/rows-closed-under-half.ts";
import { REENQUEUE_EJECTED_FLAG, failedEntriesSincePush, jobFailuresOf, mergeGroupGreenSince, ownershipOfFailure, requeueEjected, type EjectionEvidence } from "../work-gate/causes/pr-ejected.ts";
import { readArmingOf } from "../work-gate/tick/blocker-cleared-reading.ts";
import { type ArmingPort } from "../work-gate/vocabulary.ts";
import { CAUSES, JUDGMENT_CAUSES } from "../cause-declaration.ts";
import { stalledPrOrders } from "../work-gate/pr-orders/red-only-by-superseded-run.ts";
import type { Decision, ItemRef } from "../ticket-port/port.ts";

const HOME = "a11ign/a11ign";
const NOW = Date.parse("2026-10-11T17:40:00Z");
const REMOVED_AT = "2026-10-11T17:16:00Z";
const PIN_GUARD = "packages/guards/src/docs-release-pin-currency.real-tree.test.ts";
const PIN_GUARD_TEST_NAME = "no tracked doc pins an a11ign release more than one minor behind the release v0 points at";

const ON = withMachineryFlag(emptyCanaryState(), { name: REENQUEUE_EJECTED_FLAG, on: true });
const OFF = emptyCanaryState();

// --- the world: one ejected pull request, its timeline, its failed run's log, and the queue's runs --------------------------------------------------

type World = {
  number?: number;
  changed?: string[];
  /** The failing job's own lines (without the `job\tstep\t` prefix): the file its location names decides own or not. */
  log?: string[];
  /** How many `failed_checks` entries the head has had, newest last. */
  entries?: number;
  /** The queue's runs, as `gh api ... --jq` hands them over. */
  groups?: { head_branch: string; conclusion: string | null; created_at: string }[];
  /** The marker comment is already on the pull request. */
  recorded?: boolean;
  /** `pr merge` is accepted but the pull request then reads unarmed. */
  armRefused?: boolean;
  body?: string;
  /** The labels the pull request carries: none is the holder-less shape (a11ign#5115), `hold:<who>` is a hold. */
  labels?: string[];
};

const GREEN_AFTER = [{ head_branch: "gh-readonly-queue/main/pr-5123-aaa", conclusion: "success", created_at: "2026-10-11T17:30:00Z" }];
const RED_AFTER = [{ head_branch: "gh-readonly-queue/main/pr-5130-ddd", conclusion: "failure", created_at: "2026-10-11T17:30:00Z" }];

/** The TAP failure of the pin guard, with the location its diagnostic block carries. */
const tapFailure = (file: string) => [
  `2026-10-11T17:14:00.0000000Z not ok 812 - ${PIN_GUARD_TEST_NAME}`,
  "2026-10-11T17:14:00.0000000Z   ---",
  `2026-10-11T17:14:00.0000000Z   location: '/home/runner/work/a11y-witness/a11y-witness/${file}:50:1'`,
  "2026-10-11T17:14:00.0000000Z   ...",
];

/** `gh run view --log-failed`: one `job\tstep\tline` per line, the failing job and the roll-up that echoes it. */
const logFailed = (lines: string[]) => [
  ...lines.map((line) => `ts\tTest\t${line}`),
  "gate\tEvery job ran\t2026-10-11T17:15:00.0000000Z ##[error]a job reported 'ts', not success",
].join("\n");

const QUEUE_EVENTS = (entries: number) => Array.from({ length: entries }, (_, at) => [
  { __typename: "AddedToMergeQueueEvent", createdAt: `2026-10-11T16:${10 + at * 20}:00Z` },
  { __typename: "RemovedFromMergeQueueEvent", createdAt: at === entries - 1 ? REMOVED_AT : `2026-10-11T16:${30 + at * 20}:00Z`, reason: "failed_checks" },
]).flat();

/** A fake `gh`: answers the reads the tick makes and records every call. `armed` is what `pr merge` changes. */
function fakeGh(world: World = {}) {
  const number = world.number ?? 5124;
  const calls: string[][] = [];
  let armed = false;
  const run = (args: string[]): string => {
    calls.push(args);
    const line = args.join(" ");
    if (args[0] === "api" && args[1] === "graphql" && line.includes("timelineItems")) {
      return JSON.stringify({ mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: "PullRequestCommit" }, ...QUEUE_EVENTS(world.entries ?? 1)] } });
    }
    if (args[0] === "api" && args[1] === "graphql" && line.includes("-F n=")) {
      return JSON.stringify({ merged: false, autoMergeRequest: armed && world.armRefused !== true ? { enabledAt: "now" } : null, mergeQueueEntry: null });
    }
    if (args[0] === "api" && args[1] === "graphql") return JSON.stringify([{ number, isDraft: false, merged: false, autoMergeRequest: null, mergeQueueEntry: null }]);
    if (/actions\/runs\?event=merge_group/.test(line)) {
      return JSON.stringify([{ id: 9001, head_branch: `gh-readonly-queue/main/pr-${number}-ccc`, conclusion: "failure", created_at: "2026-10-11T17:12:00Z" }, ...(world.groups ?? GREEN_AFTER)]);
    }
    if (args[0] === "run" && args[1] === "view") return logFailed(world.log ?? tapFailure(PIN_GUARD));
    if (args[0] === "pr" && args[1] === "merge") { armed = true; return ""; }
    // `blockerVerdict` asks each closing row for its blocked-by edges before the arm: a CLOSED row answers like an open one.
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ blockedBy: { nodes: [], totalCount: 0 } });
    throw new Error(`fake gh: unexpected ${line.slice(0, 120)}`);
  };
  return { run, calls };
}

function fakePort() {
  const comments: { ref: ItemRef; decision: Decision }[] = [];
  const portFor = (): ArmingPort => ({
    armMerge() { throw new Error("the code-host port's arm runs arm-pr, which refuses an ejected PR: the re-queue must not go through it"); },
    postDecision(ref, decision) { comments.push({ ref, decision }); return "1"; },
  });
  return { portFor, comments };
}

/** The pull request as the tick's list carries it: green on `gate`, ready, not held, with its changed files and comments. */
const prOf = (world: World = {}) => {
  const files = world.changed ?? ["src/unrelated.ts"];
  return {
    number: world.number ?? 5124, isDraft: false, labels: (world.labels ?? []).map((name) => ({ name })), reviewDecision: "APPROVED", headRefOid: "deadbeef", body: world.body ?? "Closes: none -- test", files: files.map((path) => ({ path })), changedFiles: files.length,
    comments: world.recorded === true ? [{ body: `<!-- ejected-unqueued: ${REMOVED_AT} -->` }] : [],
    statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
  };
};

/** One tick's arming read, as `decide` is handed it. */
function tick(world: World = {}, { state = ON, now = NOW }: { state?: ReturnType<typeof emptyCanaryState>; now?: number } = {}) {
  const gh = fakeGh(world);
  const port = fakePort();
  const said: string[] = [];
  const pr = prOf(world);
  const arming = readArmingOf([pr], ["gate"], { scope: HOME, run: gh.run, portFor: port.portFor, env: {}, log: (line) => said.push(line), state, now });
  assert.ok(arming !== null, "the stubbed reads answer");
  const stamped = [...arming.ejections].map(([number, ejection]) => ({ ...pr, number, ejection }));
  const orders = stalledPrOrders(stamped, { required: ["gate"], nowMs: now });
  return { arming, gh, port, said, orders };
}

const armCalls = (gh: ReturnType<typeof fakeGh>) => gh.calls.filter((c) => c[0] === "pr" && c[1] === "merge");

// --- the row's named cases ----------------------------------------------------------------------------------------------------------------------

test("the #5124 shape: ejected by the pin guard, diff unrelated, is re-queued once main's newest merge group is green, and no owner is woken", () => {
  const { arming, gh, port, orders, said } = tick();
  assert.equal(arming.ejections.size, 0, "it left the ejected set: nobody is told to fix what is not theirs");
  assert.deepEqual(arming.stranded, []);
  assert.deepEqual(orders, [], "no order");
  assert.deepEqual(armCalls(gh), [["pr", "merge", "5124", "--repo", HOME, "--auto", "--merge"]], "armed once, by the gate, with the merge method the org uses");
  assert.equal(port.comments.length, 1, "and recorded on the pull request");
  assert.equal(port.comments[0].decision.kind, "pr-ejected-requeued");
  assert.match(port.comments[0].decision.text, /docs-release-pin-currency\.real-tree\.test\.ts, which the pull request does not change/);
  assert.match(said.join(""), /re-armed #5124/);
});

test("a PR ejected by its own test wakes its holder with the failing test, and is not re-armed", () => {
  const own = tick({ changed: ["packages/guards/src/docs-release-pin-currency.ts", "README.md"] });
  assert.deepEqual([...own.arming.ejections.keys()], [5124], "still ejected");
  assert.deepEqual(armCalls(own.gh), [], "NOT armed: re-arming without a push fails the same way");
  assert.equal(own.orders.length, 1, "the holder is woken");
  assert.equal(own.orders[0].discriminator, "ejected");
  assert.match(own.orders[0].prompt, new RegExp(`Failing subtests: .*${PIN_GUARD_TEST_NAME}`), "with the failing test named");
  assert.match(own.said.join(""), /stays the owner's -- it fails in packages\/guards\/src\/docs-release-pin-currency\.real-tree\.test\.ts, which the pull request changes or covers/);
  // THE CONTROL: the same fixture with the diff unrelated is the first test, so the branch above is reachable and the difference is the diff alone.
  assert.equal(tick({ changed: ["src/unrelated.ts"] }).arming.ejections.size, 0);
  // ... and the PR's own test file is own by the file's name too.
  assert.equal(tick({ changed: [PIN_GUARD] }).arming.ejections.size, 1);
});

test("the #5115 shape: ejected, its row CLOSED by a sibling pull request in the other repository, NO holder, green and approved, is re-queued within one tick", () => {
  // a11ign#5115: the row (#5109) was closed at 17:30 by agent-org#1007, so the pull request lost the session that held it, and three orders went to managers and none re-queued it.
  // The re-queue is the gate's own act: it asks no session, so a pull request with nobody on it is re-queued by the same call as one with a holder.
  const body = "Closes #5109\n\nAcceptance: see .acceptance/agent~pm-brief-tests-first-5109.md";
  for (const [what, labels] of [["no label at all", []], ["a `session:` label of a session that no longer exists", ["session:worker-5109"]]] as const) {
    const { arming, gh, port, orders } = tick({ number: 5115, body, labels: [...labels], changed: [".agent-org/roles/product-manager.md", ".acceptance/agent~pm-brief-tests-first-5109.md"] });
    assert.deepEqual(armCalls(gh), [["pr", "merge", "5115", "--repo", HOME, "--auto", "--merge"]], `${what}: armed once, by the gate`);
    assert.equal(arming.ejections.size, 0, `${what}: it left the ejected set`);
    assert.deepEqual(orders, [], `${what}: no manager is woken`);
    assert.deepEqual(port.comments.map((c) => c.decision.kind), ["pr-ejected-requeued"], `${what}: and the record says so`);
  }
  // THE CONTROL: a HOLD (`hold:<who>`) is what keeps a pull request out of the candidates, and it is not the absence of a holder. The re-queue does not override one.
  const held = tick({ number: 5115, body, labels: ["hold:orchestrator"] });
  assert.deepEqual(armCalls(held.gh), [], "a held pull request is not armed by the gate");
  assert.equal(held.arming.ejections.size, 0, "it is not a candidate at all: the hold's own release is what brings it back");
});

// --- every other branch: reachable from the same call ------------------------------------------------------------------------------------------

test("main is not green yet, or not known to be: the PR stays ejected and nothing is armed", () => {
  const running = [{ head_branch: "gh-readonly-queue/main/pr-5130-ddd", conclusion: null, created_at: "2026-10-11T17:30:00Z" }];
  const older = [{ head_branch: "gh-readonly-queue/main/pr-5120-eee", conclusion: "success", created_at: "2026-10-11T16:00:00Z" }];
  for (const [name, groups] of Object.entries({ red: RED_AFTER, running, older, none: [] })) {
    const read = tick({ groups });
    assert.deepEqual([...read.arming.ejections.keys()], [5124], `${name}: still ejected`);
    assert.deepEqual(armCalls(read.gh), [], `${name}: nothing armed`);
  }
});

test("once per head: a second failed_checks entry on the same head is the owner's, whatever the log says", () => {
  const twice = tick({ entries: 2 });
  assert.deepEqual([...twice.arming.ejections.keys()], [5124]);
  assert.deepEqual(armCalls(twice.gh), []);
  assert.match(twice.said.join(""), /failed the queue 2 times on this head/);
});

test("a log that names no file, or a diff that was not listed whole, is UNKNOWN, and unknown is today's order", () => {
  const noFile = tick({ log: [`2026-10-11T17:14:00.0000000Z not ok 812 - ${PIN_GUARD_TEST_NAME}`] });
  assert.equal(noFile.arming.ejections.size, 1);
  assert.deepEqual(armCalls(noFile.gh), []);
  assert.match(noFile.said.join(""), /names no file the failure is in/);
  // THE CONTROL: the same PR with its whole diff listed is re-queued.
  assert.equal(tick({}).arming.ejections.size, 0);
  const gh = fakeGh();
  const evidence = new Map<number, EjectionEvidence>([[5124, { failedEntries: 1, log: logFailed(tapFailure(PIN_GUARD)), runs: GREEN_AFTER }]]);
  const partial = { ...prOf(), changedFiles: 250 };
  const outcome = requeueEjected(new Map([[5124, { removedAt: REMOVED_AT, runId: 9001, failingTests: null }]]),
    { prs: [partial], scope: HOME, run: gh.run, portFor: fakePort().portFor, state: ON, now: NOW, log: () => {}, evidence });
  assert.deepEqual(outcome.requeued, [], "250 changed files and 1 listed prove nothing about the file that failed");
  assert.equal(outcome.remaining.size, 1);
});

test("an arm that does not read back as armed leaves the order to the owner, and records no re-queue", () => {
  const refused = tick({ armRefused: true });
  assert.equal(refused.arming.ejections.size, 1);
  assert.deepEqual(refused.port.comments.map((c) => c.decision.kind), ["pr-ejected-unqueued"], "never `pr-ejected-requeued` for an arm that did not land; it is out of the queue past the clock, and that is said");
  assert.match(refused.said.join(""), /does not read as armed/);
});

test("the flag is OFF by default, and off arms and records nothing: today's order, unchanged", () => {
  const off = tick({}, { state: OFF });
  assert.deepEqual([...off.arming.ejections.keys()], [5124]);
  assert.equal(off.orders.length, 1, "the owner's order, as before the change");
  assert.deepEqual(armCalls(off.gh), [], "no arm");
  assert.deepEqual(off.port.comments, [], "no record");
  assert.deepEqual(off.arming.stranded, []);
  // THE CONTROL: the same world with the flag on re-arms, so "off" is the only difference.
  assert.equal(tick({}, { state: ON }).arming.ejections.size, 0);
});

// --- the detector -----------------------------------------------------------------------------------------------------------------------------

test("a not-own ejection still unqueued 15 minutes on is counted as approved-unqueued and said ONCE on the pull request", () => {
  const stranded = tick({ groups: RED_AFTER });
  assert.deepEqual(stranded.arming.stranded, [5124], "24 minutes after the removal");
  assert.equal(stranded.port.comments.length, 1);
  assert.equal(stranded.port.comments[0].decision.kind, "pr-ejected-unqueued");
  assert.match(stranded.port.comments[0].decision.text, /<!-- ejected-unqueued: 2026-10-11T17:16:00Z -->/);
  // not again: the marker is on the pull request the tick already read.
  const again = tick({ groups: RED_AFTER, recorded: true });
  assert.deepEqual(again.arming.stranded, [5124], "still counted");
  assert.deepEqual(again.port.comments, [], "and not said twice");
  // younger than the clock: neither.
  const young = tick({ groups: RED_AFTER }, { now: Date.parse(REMOVED_AT) + 5 * 60_000 });
  assert.deepEqual([young.arming.stranded, young.port.comments], [[], []]);
  // its own failure is the owner's order, not a stranding.
  assert.deepEqual(tick({ groups: RED_AFTER, changed: [PIN_GUARD] }).arming.stranded, []);
});

// --- the pure parts, each alone -----------------------------------------------------------------------------------------------------------------

test("failedEntriesSincePush counts the trailing queue events and stops at a push", () => {
  const node = (type: string, reason?: string) => ({ __typename: type, reason });
  const failed = node("RemovedFromMergeQueueEvent", "failed_checks");
  const timeline = (...nodes: object[]) => ({ timelineItems: { nodes } });
  assert.equal(failedEntriesSincePush(timeline(node("PullRequestCommit"), node("AddedToMergeQueueEvent"), failed)), 1);
  assert.equal(failedEntriesSincePush(timeline(node("AddedToMergeQueueEvent"), failed, node("AddedToMergeQueueEvent"), failed)), 2);
  assert.equal(failedEntriesSincePush(timeline(failed, node("PullRequestCommit"), node("AddedToMergeQueueEvent"), failed)), 1, "a push ends the count");
  assert.equal(failedEntriesSincePush(timeline(node("RemovedFromMergeQueueEvent", "dequeued"))), 0, "a manual dequeue is not a failed entry");
  assert.equal(failedEntriesSincePush(null), 0);
});

test("mergeGroupGreenSince: the newest group must be settled, green and later than the ejection", () => {
  const at = (conclusion: string | null, created_at: string, head_branch = "gh-readonly-queue/main/pr-1-a") => ({ head_branch, conclusion, created_at });
  assert.equal(mergeGroupGreenSince([at("success", "2026-10-11T17:30:00Z")], REMOVED_AT).green, true);
  assert.equal(mergeGroupGreenSince([at("success", "2026-10-11T17:30:00Z"), at("failure", "2026-10-11T17:35:00Z", "gh-readonly-queue/main/pr-2-b")], REMOVED_AT).green, false, "the NEWEST one decides");
  assert.equal(mergeGroupGreenSince([at("success", "2026-10-11T17:30:00Z"), at(null, "2026-10-11T17:30:30Z")], REMOVED_AT).green, false, "one running run of the group");
  assert.equal(mergeGroupGreenSince([at("success", "2026-10-11T17:00:00Z")], REMOVED_AT).green, false, "older than the ejection");
  assert.equal(mergeGroupGreenSince([at("success", "2026-10-11T17:30:00Z", "feature/x")], REMOVED_AT).green, false, "a run that is not a queue branch is no merge group");
});

test("jobFailuresOf: the file a failing job names, per job, the roll-up left out and an unnamed file `null`", () => {
  assert.deepEqual(jobFailuresOf(logFailed(tapFailure(PIN_GUARD))), [{ job: "ts", file: PIN_GUARD }], "the runner's checkout prefix is removed and the roll-up is no cause");
  assert.deepEqual(jobFailuresOf(`lint\tRun\t2026-10-11T17:14:00Z ##[error]src/a.ts:3:1 Unexpected any\nts\tTest\t2026-10-11T17:14:00Z ok 1 - fine`),
    [{ job: "lint", file: "src/a.ts" }, { job: "ts", file: null }], "a job with no failing line is not outside: it is unnamed");
  assert.deepEqual(jobFailuresOf(""), []);
  // a file named only inside node_modules is not the failure's file.
  assert.deepEqual(jobFailuresOf("ts\tTest\t2026-10-11T17:14:00Z not ok 1 - x\nts\tTest\t2026-10-11T17:14:00Z at /runner/work/r/r/node_modules/pkg/index.js:1:1"), [{ job: "ts", file: null }]);
});

test("ownershipOfFailure: one own file is own, an unnamed one is unknown, and only a fully placed outside is outside", () => {
  const verdict = (files: Record<string, string | null>, changed: string[] | null) =>
    ownershipOfFailure({ failures: Object.entries(files).map(([job, file]) => ({ job, file })), changed }).kind;
  assert.equal(verdict({ ts: PIN_GUARD }, ["README.md"]), "outside");
  assert.equal(verdict({ ts: PIN_GUARD, lint: "src/a.ts" }, ["src/a.ts"]), "own", "one own file among others");
  assert.equal(verdict({ ts: PIN_GUARD, lint: null }, ["src/a.ts"]), "unknown", "one job whose log names no file keeps the whole unknown");
  assert.equal(verdict({ ts: PIN_GUARD, lint: null }, ["packages/guards/src/docs-release-pin-currency.ts"]), "own", "a file that IS named and is the PR's outranks an unnamed one");
  assert.equal(verdict({ ts: null }, ["README.md"]), "unknown");
  assert.equal(verdict({ ts: PIN_GUARD }, null), "unknown", "a diff that could not be listed");
  assert.equal(verdict({}, ["README.md"]), "unknown", "no failing job but the roll-up");
});

// --- a row closed under an open half of itself (the row's reopened clause 2) ----------------------------------------------------------------------

const AGENT_ORG = "a11ign/agent-org";
/** a11ign#5115 as the tick's list carries it: the half that stayed open, naming a row (#5109) agent-org#1007's merge closed. */
const HALF_5115 = { number: 5115, isDraft: false, body: "Closes #5109\n\nAcceptance: see .acceptance/agent~pm-brief-tests-first-5109.md" };
const openRowsWithout = (...gone: number[]) => [5100, 5109, 5120, 5125].filter((n) => !gone.includes(n)).map((number) => ({ number }));

test("a row closed under an open half is found: a11ign#5115 still names #5109, which is no longer on the tracker's open list", () => {
  const found = rowsClosedUnderOpenHalf({ prs: [HALF_5115], trackers: [{ repo: HOME, rows: openRowsWithout(5109) }], homeRepo: HOME });
  assert.deepEqual(found, [{ row: `${HOME}#5109`, half: `${HOME}#5115` }]);
  // THE CROSS-REPOSITORY FORM: the half is an agent-org pull request naming the row by its owner/repo.
  const named = { number: 1007, isDraft: false, repo: AGENT_ORG, body: `Closes ${HOME}#5109` };
  assert.deepEqual(rowsClosedUnderOpenHalf({ prs: [named], trackers: [{ repo: HOME, rows: openRowsWithout(5109) }], homeRepo: HOME }), [{ row: `${HOME}#5109`, half: `${AGENT_ORG}#1007`, halfKey: "agent-org" }]);
  // THE CONTROLS, each the same pull request with one thing changed, so the finding above is the open list's absence alone:
  const none = (over: object, rows: readonly any[] | null = openRowsWithout(5109)) => rowsClosedUnderOpenHalf({ prs: [{ ...HALF_5115, ...over }], trackers: [{ repo: HOME, rows }], homeRepo: HOME });
  assert.deepEqual(none({}, openRowsWithout()), [], "the row is open: nothing to say");
  assert.deepEqual(none({}, null), [], "the list was REFUSED: absence from a list nobody read is not closure");
  assert.deepEqual(none({}, Array.from({ length: 500 }, (_, at) => ({ number: at + 1 }))), [], "a list at the read's limit may be cut");
  assert.deepEqual(none({ isDraft: true }), [], "a draft is not a half that has been put forward");
  assert.deepEqual(none({ body: "Closes: none -- first half of #5109" }), [], "a pull request that declares it closes nothing names no row");
  assert.deepEqual(rowsClosedUnderOpenHalf({ prs: [HALF_5115], trackers: [{ repo: AGENT_ORG, rows: [] }], homeRepo: HOME }), [], "a row of a tracker nobody listed is not read as closed");
});

test("the order goes to product-manager once per (row, half), names both and the reopen, and the flag OFF reads and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "closed-under-half-"));
  try {
    checkOrders(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the order's subject is the half's repository KEY, not the basename of its repository (reviewer-agent-org-1060)", () => {
  const dir = mkdtempSync(join(tmpdir(), "closed-under-half-key-"));
  try {
    const HALF_ON = withMachineryFlag(emptyCanaryState(), { name: CLOSED_UNDER_HALF_FLAG, on: true });
    // key `layer` for `acme/other`, and a second repository with the SAME basename under another owner and another key: the two must not share a routing identity.
    const half = (key: string, repo: string, closes: number) => ({ number: 7, isDraft: false, repo, repoKey: key, body: `Closes ${HOME}#${closes}` });
    const prs = [half("layer", "acme/other", 5101), half("layer2", "elsewhere/other", 5102)];
    const orders = closedUnderHalfOrders({ prs, trackers: [{ repo: HOME, rows: [] }], homeRepo: HOME, stateDir: dir, state: HALF_ON, log: () => {} });
    assert.deepEqual(orders.map((order) => order.subject).sort(), ["pr-layer#7", "pr-layer2#7"]);
    assert.equal(new Set(orders.map((order) => order.causeKey)).size, 2, "two halves, two routing identities");
    assert.match(orders.find((order) => order.subject === "pr-layer#7")!.prompt, /acme\/other#7/, "the prompt keeps the full repository");
    // THE CONTROL: the primary's own half stays the bare number, and carries no key.
    const own = rowsClosedUnderOpenHalf({ prs: [HALF_5115], trackers: [{ repo: HOME, rows: openRowsWithout(5109) }], homeRepo: HOME });
    assert.equal("halfKey" in own[0], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the order carries its own cause, row-closed-under-open-half, and never ready-row-unclaimable (agent-org#1060)", () => {
  const dir = mkdtempSync(join(tmpdir(), "closed-under-half-cause-"));
  try {
    const HALF_ON = withMachineryFlag(emptyCanaryState(), { name: CLOSED_UNDER_HALF_FLAG, on: true });
    const orders = closedUnderHalfOrders({ prs: [HALF_5115], trackers: [{ repo: HOME, rows: openRowsWithout(5109) }], homeRepo: HOME, stateDir: dir, state: HALF_ON, log: () => {} });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].cause, "row-closed-under-open-half");
    assert.notEqual(orders[0].cause, "ready-row-unclaimable", "a refused claim and a closed row are two causes, and the trace reads them apart");
    // THE CONTROL: the new cause is declared as a judgment finish cause, and `ready-row-unclaimable` is still declared as it was.
    assert.ok(CAUSES.includes("row-closed-under-open-half"));
    assert.ok(JUDGMENT_CAUSES.includes("row-closed-under-open-half"), "durable, so wake's expiry does not re-ask it");
    assert.ok(JUDGMENT_CAUSES.includes("ready-row-unclaimable"), "its one meaning, a refused claim, is unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function checkOrders(dir: string): void {
  const said: string[] = [];
  const HALF_ON = withMachineryFlag(emptyCanaryState(), { name: CLOSED_UNDER_HALF_FLAG, on: true });
  const ask = (state: typeof ON, prs: object[] = [HALF_5115]) =>
    closedUnderHalfOrders({ prs, trackers: [{ repo: HOME, rows: openRowsWithout(5109) }], homeRepo: HOME, stateDir: dir, state, log: (line) => said.push(line) });
  assert.deepEqual(ask(ON), [], "flag OFF (the re-queue flag is on, and is another flag): no order");
  assert.equal(existsSync(join(dir, CLOSED_UNDER_HALF_FILE)), false, "flag OFF: nothing written");
  const first = ask(HALF_ON);
  assert.equal(first.length, 1, said.join(" | "));
  assert.equal(first[0].session, "product-manager");
  assert.equal(first[0].subject, "pr-5115");
  assert.match(first[0].prompt, new RegExp(`Row ${HOME}#5109 is CLOSED, and ${HOME}#5115 .* still .Closes. it`));
  assert.match(first[0].prompt, new RegExp(`gh issue reopen 5109 --repo ${HOME}`));
  assert.deepEqual(ask(HALF_ON), [], "the next tick says nothing: once per row and half");
  assert.deepEqual(ask(HALF_ON, []), [], "the half merged or closed: nothing standing");
  assert.equal(ask(HALF_ON).length, 1, "and a half that stands again is a new reading, because the record was pruned of what no longer stood");
}
