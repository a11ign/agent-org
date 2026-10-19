import { existsSync, readFileSync } from "node:fs";
import { READS_OUTSIDE, touchesDiff } from "../../ci-failure-class.ts";
import { CANARY_STATE_FILE } from "../../org-health/claim-refusal.ts";
import { UNQUEUED_MINUTES } from "../../org-health.ts";
import { parseCanaryState, machineryFlagOn, emptyCanaryState, type CanaryState } from "../../org-health/fleet-build-readings.ts";
import { ejectionQueryArgs, queueEjectionOf } from "../../pr-armed-state.ts";
import { summarizeTestLog, testIdentity } from "../../parent-recheck-summary.ts";
import { TRACKER } from "../../ticket-port/github-adapter.ts";
import { armedAlready, blockerVerdict } from "../../arm-pr.ts";
import { defaultRun, repoNow } from "../reads/read-memo-and-exit.ts";
import { type ArmingPort, MS_PER_MINUTE, REVIEWER_STATE_DIR } from "../vocabulary.ts";

/** What the gate knows of one ejection: when, which run, which subtests. */
export type EjectionFacts = { removedAt: string | null; runId: number | null; failingTests: string[] | null; };

/**
 * #3019: WHICH OF THE UNARMED CANDIDATES WERE ARMED AND THEN EJECTED, split out before `greenUnarmedOrders` sees them.
 *
 * `readUnarmed` says "nothing is armed NOW"; that is also what a PR the queue removed for a red `merge_group` run looks like,
 * and the order built from it told `product-manager` to re-arm it into a third red run. Each candidate's timeline is read
 * (one call each -- the candidates are the few PRs a tick found green and unarmed) and an ejected one is returned with what
 * the owner needs: when, which run, which subtests.
 *
 * `null` WHEN THE CANDIDATES THEMSELVES WERE REFUSED, and a candidate whose OWN timeline read is refused or unreadable is
 * DROPPED FROM BOTH SIDES: it is neither called unarmed nor called ejected, because either would be a guess and an order
 * built on a guess is the defect this fixes. A refused read sends no order, never a false all-clear.
 *
 * @param unarmed `readUnarmed`'s answer
 */
export function readEjections(unarmed: number[] | null, run: (args: string[]) => string = defaultRun): { unarmed: number[]; ejections: Map<number, EjectionFacts>; evidence: Map<number, EjectionEvidence>; } | null {
  if (unarmed === null) return null;
  const ejections = new Map();
  const evidence = new Map<number, EjectionEvidence>(); // a11ign#5125: what the re-queue decides from; apart from the facts, which the order's tests compare whole
  const stillUnarmed = [];
  for (const number of unarmed) {
    const ejection = readEjection(number, run);
    if (ejection === null) continue;
    if (!ejection.ejected) { stillUnarmed.push(number); continue; }
    const { runs, log, ...facts } = readEjectionRun(number, ejection.removedAt, run);
    ejections.set(number, facts);
    evidence.set(number, { failedEntries: ejection.failedEntries, log, runs });
  }
  return { unarmed: stillUnarmed, ejections, evidence };
}

function readEjection(number: number, run: (args: string[]) => string) {
  try {
    const timeline = JSON.parse(run(ejectionQueryArgs({ number, repo: repoNow() })));
    const ejection = queueEjectionOf(timeline);
    return ejection === null ? null : { ...ejection, failedEntries: failedEntriesSincePush(timeline) };
  } catch {
    return null; // refused or not JSON: `queueEjectionOf(null)`'s own answer for "the API did not say"
  }
}

/**
 * The failed `merge_group` run behind one ejection and the subtests it failed -- each fact `null` when it could not be read,
 * because an order that names an ejection without its run is still better than none, and one that INVENTS a run is worse.
 *
 * The run is found by its branch (`gh-readonly-queue/main/pr-<n>-<sha>`, measured on `agent-org#16`): the newest failed
 * `merge_group` run for this PR created no later than the removal. A PR ejected twice has two, and the removal time picks.
 */
function readEjectionRun(number: number, removedAt: string | null, run: (args: string[]) => string) {
  // `runs` and `log` are a11ign#5125's evidence (the queue's newest runs, and the failed run's own log): the same two reads, kept for the re-queue instead of read again.
  const found = { removedAt, runId: (null as number | null), failingTests: (null as string[] | null), runs: (null as MergeGroupRun[] | null), log: (null as string | null) };
  try {
    const runs: (MergeGroupRun & { id: number; })[] = JSON.parse(run(["api", `repos/${repoNow()}/actions/runs?event=merge_group&per_page=50`, "--jq", "[.workflow_runs[] | {id, head_branch, conclusion, created_at}]"]));
    found.runs = runs;
    const failed = runs
      .filter((r) => String(r.head_branch).includes(`/pr-${number}-`) && r.conclusion === "failure"
        && (removedAt === null || String(r.created_at) <= removedAt))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!failed) return found;
    found.runId = Number(failed.id);
    found.log = run(["run", "view", String(failed.id), "--repo", repoNow(), "--log-failed"]);
    found.failingTests = failingSubtestsOf(found.log);
  } catch {
    /* the facts read so far stand; the order says the rest could not be read */
  }
  return found;
}

/**
 * The failing subtest identities in a `--log-failed` dump, capped so a mass failure does not become the order.
 * `null` when the log names none: "the log did not say" is a different report from "no subtest failed".
 */
function failingSubtestsOf(log: string): string[] | null {
  const lines = log.split("\n").map((l) => l.replace(/^.*?\t.*?\t/, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""));
  const { notOkLines } = summarizeTestLog(lines.join("\n"));
  const names = [...new Set(notOkLines.map(testIdentity))];
  return names.length === 0 ? null : names.slice(0, MAX_EJECTION_SUBTESTS);
}

const MAX_EJECTION_SUBTESTS = 5;

// =====================================================================================================================
// a11ign#5125: A PULL REQUEST THE QUEUE EJECTED FOR A FAILURE OUTSIDE ITS OWN DIFF IS RE-QUEUED BY THE GATE, ONCE, WHEN THE NEWEST MERGE GROUP IS GREEN.
//
// Measured 2026-10-11: #5115, #5122 and #5124 were each ejected (`failed_checks`) by ONE test that reads the world (the newest release), and nothing re-queued them once `main` was green: auto-merge is
// cleared on ejection, so they sat approved, clean and unarmed until the chairman's session armed them by hand. `arm-pr` and `auto-arm-sweep` refuse an ejected PR with an unmoved head (#3019, #3487), and
// that is right when the red may be the PR's own; this is the case where it provably is not.
//
//   OWN OR NOT is #5098's question asked of the ejection's own failed run: the file each failing job names (from the `--log-failed` the order already reads) against the PR's changed files (`touchesDiff`,
//   widened to the same stem, so `x.ts` and `x.real-tree.test.ts` cover each other). ONLY A POSITIVE "OUTSIDE" RE-QUEUES: a job whose log names no file or a diff that could not be listed whole is
//   `unknown`, and unknown is today's order to the owner.
//   ONCE PER HEAD: a second `failed_checks` entry since the last push is the owner's, whatever the log says, so a wrong "outside" costs one queue run and never a loop.
//   WHEN: the newest merge group run on the repository is settled, green and later than the ejection. A red or running one means `main` is not known to be fixed.
//   THE FLAG `queue.reenqueueEjected` (`machinery-canary.json`, default OFF): off reads nothing more and sends today's order.
//   THE DETECTOR: a not-own ejection still out of the queue after `UNQUEUED_MINUTES` is counted into `approved-unqueued` (the canary's signal) and said once on the pull request, so one the gate could
//   not re-queue is not silent.
//   THE ARM is `gh pr merge --auto --merge` from here, one new call shape (`pr merge`, within `docs/gh-call-baseline.json`'s allowance, which this does not raise): the code-host port's `armMerge` runs
//   `arm-pr`, which refuses an ejected PR by design, and a fifth port operation is `ceo`'s to rule (ADR 0046).
// =====================================================================================================================

/** The machinery flag that lets the gate re-arm an ejection that is not the pull request's own. */
export const REENQUEUE_EJECTED_FLAG = "queue.reenqueueEjected";

// =====================================================================================================================
// agent-org#1647: A NETWORK ERROR IN AN INSTALL STEP IS INFRASTRUCTURE, AND THE GATE RE-QUEUES IT ONCE.
//
// Measured 2026-10-16: agent-org#1639 was approved and green, and the queue ejected it because the merge group's `typecheck` job failed in its dependency install with `npm error code ECONNRESET` (run 38936509518).
// A job that fails before any source runs names no file, so `ownershipOfFailure` called it `unknown` and the ejection stayed the owner's for about two hours, until a person re-armed it. The org already knows
// what a network failure looks like (`READS_OUTSIDE`), so this reads it in the failed log.
//
//   THE SHAPE: the failing job's FAILED STEP is an install (its name says `install`) and a line of that step carries `READS_OUTSIDE` or a registry 5xx. The LAST error line is no signature: npm ends on `A complete log
//   of this run can be found in`, so the whole step is read. A failure that names a file the PR changes is still `own`, and a log with no signature is still `unknown`.
//   ONCE PER HEAD: the same bound `REQUEUES_PER_HEAD` keeps for the other case. A second `failed_checks` on this head is the owner's, whatever the log says.
//   NO GREEN-MERGE-GROUP WAIT: that wait answers "is main fixed"; a dropped connection broke nothing on main, and the bound already caps what a wrong reading costs at one queue run.
//   THE FLAG `queue.reenqueueInfra` (`machinery-canary.json`, default OFF), apart from `queue.reenqueueEjected`: off sends today's order, and nothing is read or written.
//   THE DETECTOR: an ejection that stays the owner's while its failure is of this shape is never silent. `networkNotRequeued` names it with its error line, the tick says so, and the canary counts it
//   (`ejected-network-not-requeued`) whether the flag is on (the bound is spent, the arm failed) or off (nothing re-queued it). The reading is of the log the tick already holds: no further call is made.
// =====================================================================================================================

/** The machinery flag that lets the gate re-arm an ejection whose failure was a network error in an install step. */
export const REENQUEUE_INFRA_FLAG = "queue.reenqueueInfra";

/** A step that installs: the failed step's name says so (`Install the dev dependencies ...`, `Install the tool's dependencies`). */
const INSTALL_STEP = /install/i;

/** A registry that answered 5xx: npm prints `npm error code E502` and `npm error 503 Service Unavailable`, and pnpm `ERR_PNPM_FETCH_5xx` / `ERR_PNPM_TARBALL_DOWNLOAD`. `READS_OUTSIDE` is the network half. */
const REGISTRY_5XX = /\bE5\d\d\b|\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)\b|ERR_PNPM_FETCH_5\d\d/i;

const QUEUE_EVENT_TYPES = ["AddedToMergeQueueEvent", "RemovedFromMergeQueueEvent"];

/** The merge queue's own branches, `gh-readonly-queue/<base>/pr-<n>-<sha>`: every merge group run is on one. */
const MERGE_GROUP_BRANCH = /^gh-readonly-queue\//;

const RUN_NOT_RED = ["success", "skipped", "neutral"];

/** The roll-up job is red whenever another job is, so it names no cause (`ci-failure-class.ts`'s `AGGREGATOR_CHECK`, which that file does not export). */
const ROLL_UP_JOB = /(^|[\s/])gate$/i;

/** What a test runner prints for the test that failed (`ci-failure-class.ts`'s `TEST_FAILURE`, likewise not exported). */
const FAILING_LINE = /^(?:##\[error\]|FAIL\b|not ok\b)/;

const LOG_TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/;

const NAMED_SOURCE_FILE = /((?:[\w@.-]+\/)*[\w@.-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|rb|go|rs|sh|ya?ml|json))\b/;

/** How far past the failing line a log may name the file: the TAP diagnostic block carries `location:` a few lines on. */
const FILE_WINDOW_LINES = 30;

/** An ejected PR is re-queued by the gate this many times per head; the next `failed_checks` entry is its owner's. */
const REQUEUES_PER_HEAD = 1;

/** The marker the record on the pull request carries, so the next tick finds it in the comments it already read and says nothing twice. */
const STRANDED_MARKER = "ejected-unqueued:";

/**
 * PURE. How many times the queue removed this pull request for `failed_checks` since its head last moved: the trailing run of queue events in the timeline (a commit or a force-push ends it). `queueEjectionOf`
 * answers whether the NEWEST event is such a removal; this is how many there have been, which is what "once" is counted from.
 */
export function failedEntriesSincePush(pr: { timelineItems?: { nodes?: unknown } } | null): number {
  const nodes = pr?.timelineItems?.nodes;
  if (!Array.isArray(nodes)) return 0;
  let count = 0;
  for (const node of [...nodes].reverse()) {
    if (!QUEUE_EVENT_TYPES.includes(node?.__typename)) break;
    if (node.__typename === "RemovedFromMergeQueueEvent" && node.reason === "failed_checks") count++;
  }
  return count;
}

export type MergeGroupRun = { head_branch: string; conclusion: string | null; created_at: string };

/**
 * PURE. Is the NEWEST merge group on the repository settled, green and later than `since`? A group is the runs on one `gh-readonly-queue/` branch. It must be LATER than the ejection, because an older green says nothing
 * about the failure that ejected the PR, and SETTLED, because a running one is neither. The reason is said in words for the record on the pull request.
 */
export function mergeGroupGreenSince(runs: readonly MergeGroupRun[], since: string): { green: boolean; why: string; } {
  const groups = new Map<string, MergeGroupRun[]>();
  for (const run of runs.filter((r) => MERGE_GROUP_BRANCH.test(String(r.head_branch)))) groups.set(run.head_branch, [...(groups.get(run.head_branch) ?? []), run]);
  const newest = [...groups.entries()].map(([branch, members]) => ({ branch, members, at: members.map((m) => String(m.created_at)).sort().at(-1) as string })).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (newest === undefined) return { green: false, why: "no merge group run was listed" };
  if (newest.at <= since) return { green: false, why: `the newest merge group run (${newest.at}) is no later than the ejection (${since})` };
  if (newest.members.some((m) => m.conclusion === null)) return { green: false, why: `the newest merge group (${newest.branch}) is still running` };
  const red = newest.members.filter((m) => !RUN_NOT_RED.includes(String(m.conclusion)));
  return red.length === 0 ? { green: true, why: `the newest merge group (${newest.branch}, ${newest.at}) is green` } : { green: false, why: `the newest merge group (${newest.branch}) is red` };
}

/**
 * One failing job of the ejected run and the source file its log names (`null` when it names none). `network` is present only when the failed step is an install and a line of it is a network or registry
 * failure (agent-org#1647): that line, as the log prints it.
 */
export type JobFailure = { job: string; file: string | null; network?: string };

/**
 * PURE. The failing jobs of a `--log-failed` dump (`<job>\t<step>\t<time> <line>`) and the file each names: from the job's first failing line on, the first source file within `FILE_WINDOW_LINES`, with the
 * runner's checkout prefix removed. The roll-up job is left out (it names no cause), and a job with no failing line is `null`: absence is not "outside". This is `ci-failure-class.ts`'s `failingFile`
 * on the log the order already reads, so the ownership question costs no further call.
 */
export function jobFailuresOf(log: string): JobFailure[] {
  const byJob = new Map<string, { step: string; line: string }[]>();
  for (const raw of log.split("\n")) {
    const [job, step, ...rest] = raw.split("\t");
    if (rest.length === 0 || job.trim() === "" || ROLL_UP_JOB.test(job.trim())) continue;
    byJob.set(job.trim(), [...(byJob.get(job.trim()) ?? []), { step, line: rest.join("\t").replace(LOG_TIMESTAMP, "") }]);
  }
  return [...byJob.entries()].map(([job, entries]) => {
    const lines = entries.map((entry) => entry.line);
    const at = lines.findIndex((line) => FAILING_LINE.test(line));
    const network = entries.filter((entry) => INSTALL_STEP.test(entry.step)).map((entry) => entry.line.trim()).find((line) => READS_OUTSIDE.test(line) || REGISTRY_5XX.test(line));
    return { job, file: at < 0 ? null : fileNamedIn(lines.slice(at, at + FILE_WINDOW_LINES)), ...(network === undefined ? {} : { network }) };
  });
}

function fileNamedIn(lines: readonly string[]): string | null {
  for (const line of lines) {
    const found = NAMED_SOURCE_FILE.exec(line)?.[1];
    if (found === undefined || found.includes("node_modules/")) continue;
    return found.replace(/^.*?\/work\/[^/]+\/[^/]+\//, "").replace(/^\.\//, "");
  }
  return null;
}

const stemOf = (path: string): string => (path.split("/").at(-1) ?? path).split(".")[0];

/** `infrastructure` (agent-org#1647) carries `line`: the network or registry line that says so. */
export type Ownership = { kind: "outside" | "own" | "unknown" | "infrastructure"; why: string; line?: string; };

/**
 * PURE. Does the failure of an ejected run sit OUTSIDE the pull request's diff? Every failing job must name a file, and none of those files may be one the PR changes or the one beside it (`touchesDiff`, and the
 * same stem). ONE OWN FILE IS OWN; no failing job, one log that names no file or a diff that could not be listed is UNKNOWN: neither is ever `outside`.
 * INFRASTRUCTURE (agent-org#1647) is every failing job having failed in an install step on the network or the registry, and it is asked AFTER own: a file the PR changes outranks it.
 */
export function ownershipOfFailure({ failures, changed }: { failures: readonly JobFailure[]; changed: readonly string[] | null; }): Ownership {
  if (failures.length === 0) return { kind: "unknown", why: "the log names no failing job but the roll-up" };
  if (changed === null) return { kind: "unknown", why: "the pull request's changed files could not be listed whole" };
  const unnamed = failures.find((failure) => failure.file === null);
  const files = failures.flatMap((failure) => (failure.file === null ? [] : [failure.file]));
  const own = files.find((file) => touchesDiff(file, changed) || changed.some((path) => stemOf(path) === stemOf(file)));
  if (own !== undefined) return { kind: "own", why: `it fails in ${own}, which the pull request changes or covers` };
  const lines = failures.flatMap((failure) => (failure.network === undefined ? [] : [failure.network]));
  if (lines.length === failures.length) return { kind: "infrastructure", why: `the install step of \`${failures.map((failure) => failure.job).join("`, `")}\` failed on the network or the registry (${lines[0]})`, line: lines[0] };
  if (unnamed !== undefined) return { kind: "unknown", why: `the log of \`${unnamed.job}\` names no file the failure is in` };
  return { kind: "outside", why: `it fails in ${files.join(", ")}, which the pull request does not change` };
}

/** The files a pull request changes as the tick's list carries them, or `null` when the list is not the whole of it (a truncated list proves nothing about a file it does not show). */
function changedFilesOf(pr: any): string[] | null {
  const files = Array.isArray(pr?.files) ? pr.files.map((f: any) => String(f?.path ?? f)) : null;
  const isComplete = files !== null && files.length > 0 && files.length >= Number(pr?.changedFiles ?? Infinity);
  return isComplete ? files : null;
}

/** The flag's state, read from the state directory; absent, unreadable or malformed is OFF, and a malformed file is said so it is not a silent default. */
export function readReenqueueState(dir: string = REVIEWER_STATE_DIR, log: (line: string) => void = (line) => process.stderr.write(line)): CanaryState {
  const path = `${dir}/${CANARY_STATE_FILE}`;
  if (!existsSync(path)) return emptyCanaryState();
  try {
    return parseCanaryState(readFileSync(path, "utf8"));
  } catch (error) {
    log(`queue.reenqueueEjected: ${CANARY_STATE_FILE} is unreadable (${String((error as Error).message).split("\n")[0]}); the flag reads OFF.\n`);
    return emptyCanaryState();
  }
}

/** What `readEjections` read besides the facts the order carries: kept apart because the order's facts are compared whole by their tests. */
export type EjectionEvidence = { failedEntries: number; log: string | null; runs: MergeGroupRun[] | null; };

export type RequeueContext = {
  prs: readonly any[]; scope: string; run: (args: string[]) => string; portFor: (scope: string) => ArmingPort; state: CanaryState; now: number; log: (line: string) => void;
  evidence: ReadonlyMap<number, EjectionEvidence>;
};

/** An ejection that stays the owner's although its failure is a network error in an install step (agent-org#1647): `at` is the removal's epoch ms, `null` when the timeline did not say. */
export type NetworkNotRequeued = { number: number; at: number | null; line: string; why: string };

export type RequeueOutcome = { remaining: Map<number, EjectionFacts>; requeued: number[]; stranded: number[]; networkNotRequeued: NetworkNotRequeued[]; };

/** What the gate says about one ejection: re-queue it, or keep today's order (`outside` when the failure was shown not to be the PR's own, which is what makes it stranded past the clock). `network` is the install line when it was one. */
type RequeueDecision = { requeue: true; why: string; network?: string; flag: string } | { requeue: false; why: string; outside: boolean; network?: string };

/** Which of the two re-queues are on. The first answers "main was red and is green"; the second "the install lost its connection". */
type Allowed = { ejected: boolean; infra: boolean };

function decideRequeue(number: number, facts: EjectionFacts, ctx: RequeueContext, allowed: Allowed): RequeueDecision {
  const evidence = ctx.evidence.get(number);
  const keep = (why: string, { outside = false, network }: { outside?: boolean; network?: string; } = {}): RequeueDecision => ({ requeue: false, why, outside, ...(network === undefined ? {} : { network }) });
  if (evidence === undefined || evidence.log === null) return keep("the failed merge group run's log could not be read, so the failure cannot be placed");
  const pr = ctx.prs.find((candidate) => Number(candidate?.number) === number);
  const owned = ownershipOfFailure({ failures: jobFailuresOf(evidence.log), changed: changedFilesOf(pr) });
  const network = owned.kind === "infrastructure" ? owned.line : undefined; // classified BEFORE the bound, so a spent bound is still counted by the detector
  if (evidence.failedEntries > REQUEUES_PER_HEAD) return keep(`it has failed the queue ${evidence.failedEntries} times on this head, and the gate re-queues once`, { network });
  if (owned.kind === "infrastructure") return allowed.infra ? { requeue: true, why: owned.why, network, flag: REENQUEUE_INFRA_FLAG } : keep(`${owned.why}; ${REENQUEUE_INFRA_FLAG} is off`, { network });
  if (!allowed.ejected) return keep(owned.why);
  if (owned.kind !== "outside") return keep(owned.why);
  if (evidence.runs === null) return keep(`${owned.why}; the merge group runs could not be listed`, { outside: true });
  const green = mergeGroupGreenSince(evidence.runs, facts.removedAt ?? "");
  return green.green ? { requeue: true, why: `${owned.why}; ${green.why}`, flag: REENQUEUE_EJECTED_FLAG } : keep(`${owned.why}; ${green.why}`, { outside: true });
}

/** The arm itself, and the record of it. `null` when the pull request is armed again, else why it is not. */
function armEjected(number: number, ctx: RequeueContext, { why, flag }: { why: string; flag: string; }): string | null {
  const pr = ctx.prs.find((candidate) => Number(candidate?.number) === number);
  const blocker = blockerVerdict({ repo: ctx.scope, prBody: pr?.body ?? null, run: (args) => ctx.run(args) });
  if (blocker.kind !== "clear") return blocker.why;
  try {
    ctx.run(["pr", "merge", String(number), "--repo", ctx.scope, "--auto", "--merge"]);
    if (armedAlready({ number: String(number), repo: ctx.scope, run: (_cmd, args) => ctx.run(args), error: () => {} }) === null) return "the merge was requested and the pull request does not read as armed";
  } catch (error) {
    return String((error as Error).message ?? error).split("\n")[0].slice(0, 200);
  }
  try {
    ctx.portFor(ctx.scope).postDecision({ tracker: TRACKER, scope: ctx.scope, id: number }, { role: "work-gate", runId: `tick-${ctx.now}`, kind: "pr-ejected-requeued", text:
      `**work-gate, pr-ejected-requeued:** the merge queue ejected this pull request for \`failed_checks\`, and the failure was not its own: ${why}. The gate armed it again (${flag === REENQUEUE_INFRA_FLAG ? "agent-org#1647" : "a11ign#5125"}, flag \`${flag}\`). `
      + "It is re-queued once per head: a second ejection on this head is the owner's." });
  } catch (error) {
    ctx.log(`pr-ejected-requeued: #${number} is armed; the record could not be posted (${String((error as Error).message ?? error).split("\n")[0].slice(0, 120)}).\n`);
  }
  return null;
}

/**
 * a11ign#5125: RE-QUEUE THE EJECTIONS THAT WERE NOT THE PULL REQUEST'S OWN, and hand back the rest for today's order. `remaining` is `ejections` less the re-queued ones; `stranded` is the not-own ones still out of
 * the queue `UNQUEUED_MINUTES` after the ejection, which the caller counts into `approved-unqueued`. With BOTH flags OFF nothing is read or written and `ejections` comes back whole.
 * agent-org#1647: `networkNotRequeued` is every ejection whose failure was a network error in an install step and that this call did NOT re-queue, flags on or off: it is said in the tick's log with its error line,
 * and the canary counts it. It is a reading of the log the tick holds, so it costs no call. With only `queue.reenqueueInfra` on, only that kind is acted on and the rest are left untouched and unsaid.
 * Never throws: every refused read is a "keep", and a kept ejection is the owner's order as it was.
 */
export function requeueEjected(ejections: Map<number, EjectionFacts>, ctx: RequeueContext): RequeueOutcome {
  const remaining = new Map(ejections);
  const outcome: RequeueOutcome = { remaining, requeued: [], stranded: [], networkNotRequeued: [] };
  const allowed = { ejected: machineryFlagOn(ctx.state, REENQUEUE_EJECTED_FLAG), infra: machineryFlagOn(ctx.state, REENQUEUE_INFRA_FLAG) };
  for (const [number, facts] of ejections) {
    const decision = decideRequeue(number, facts, ctx, allowed);
    if (!allowed.ejected && !(allowed.infra && decision.network !== undefined)) { noteNetwork(number, facts, decision, outcome, ctx); continue; } // today's behaviour, less the detector's reading
    const failed = decision.requeue ? armEjected(number, ctx, decision) : decision.why;
    if (failed === null) { remaining.delete(number); outcome.requeued.push(number); ctx.log(`pr-ejected-requeued: re-armed #${number} -- ${decision.why}.\n`); continue; }
    ctx.log(`pr-ejected-requeued: #${number} stays the owner's -- ${failed}.\n`);
    noteNetwork(number, facts, { ...decision, why: failed }, outcome, ctx);
    if (decision.requeue || decision.outside) noteStranded(number, facts, { ctx, outcome, why: failed });
  }
  return outcome;
}

/** agent-org#1647: the detector. An ejection that stays the owner's while its failure is a network error is recorded, once per tick, with the install line. */
function noteNetwork(number: number, facts: EjectionFacts, decision: { network?: string; why: string; }, outcome: RequeueOutcome, ctx: RequeueContext): void {
  if (decision.network === undefined) return;
  const at = Date.parse(facts.removedAt ?? "");
  outcome.networkNotRequeued.push({ number, at: Number.isFinite(at) ? at : null, line: decision.network, why: decision.why });
  ctx.log(`ejected-network-not-requeued: #${number} stays the owner's although its install failed on the network (${decision.network}) -- ${decision.why}.\n`);
}

/** A not-own ejection still unqueued past the clock is counted, and said once on the pull request; a younger one waits for the next tick. */
function noteStranded(number: number, facts: EjectionFacts, { ctx, outcome, why }: { ctx: RequeueContext; outcome: RequeueOutcome; why: string; }): void {
  const removed = Date.parse(facts.removedAt ?? "");
  if (!Number.isFinite(removed) || ctx.now - removed < UNQUEUED_MINUTES * MS_PER_MINUTE) return;
  outcome.stranded.push(number);
  const marker = `${STRANDED_MARKER} ${facts.removedAt}`;
  const pr = ctx.prs.find((candidate) => Number(candidate?.number) === number);
  if ((pr?.comments ?? []).some((comment: any) => String(comment?.body ?? "").includes(marker))) return;
  try {
    ctx.portFor(ctx.scope).postDecision({ tracker: TRACKER, scope: ctx.scope, id: number }, { role: "work-gate", runId: `tick-${ctx.now}`, kind: "pr-ejected-unqueued", text:
      `**work-gate, pr-ejected-unqueued:** the merge queue ejected this pull request for \`failed_checks\` at ${facts.removedAt}, the failure was not its own, and it is still out of the queue ${UNQUEUED_MINUTES} minutes `
      + `later. The gate did not re-queue it: ${why}. Re-arm it (\`gh pr merge ${number} --auto --merge\`) once the failure is cleared. Counted in \`approved-unqueued\`.\n\n<!-- ${marker} -->` });
  } catch (error) {
    ctx.log(`pr-ejected-requeued: could not record #${number}'s stranding (${String((error as Error).message ?? error).split("\n")[0].slice(0, 120)}); the next tick retries.\n`);
  }
}
