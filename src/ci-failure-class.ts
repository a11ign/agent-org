// #4632: A RED PULL REQUEST'S FAILURE IS CLASSIFIED, AND ROUTED BY CLASS. A `pr-checks-failing` order says a check is red and leaves every judgment to its reader: whose defect, whether to
// rerun, whether another repository moved. This module answers those four from the failing test's error lines plus facts the CODE computed, and returns the class and its route as DATA.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). It goes through `decide` (`decision-provider.ts`) as the use `ci-failure-class`, so there is no client, key read or switch here. With no
// provider, no key, the use switched off, a refusal, a timeout or a confidence under the floor the answer is {@link fallbackClass}, and nothing breaks or nags.
//
// THE PROVIDER ONLY CLASSIFIES. It never reruns, labels or comments: the gate does that from {@link CiFailureDecision.route}, in its own code. The FACTS (does the same test fail on `main`,
// on other open PRs, does it read outside its repository, is the text a rate limit) are computed by the caller and passed in as state; they are never asked of the provider.
//
// THE CALLER IS `wake.ts` (#4888), NOT THE GATE: `work-gate.ts` is synchronous end to end and a provider call is not, so the gate's order is classified at the one async seam the tick has,
// beside `routesForStarts`, just before delivery. {@link readCiFailure} reads the facts there; they are CODE's reading of GitHub (REST, the core pool) and never the provider's.
import { CLAIM_LABEL } from "./claim-labels.ts";
import { REPO } from "./project-identity.ts"; // #2616: the project's repository comes from its declaration, never a literal
import { PROJECT_NUMBER, PROJECT_OWNER } from "./board-snapshot-scope.ts"; // #5405: the incident row is boarded on the home board when it is filed
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL } from "./project-vocabulary.ts";
import { boardFiledRow } from "./ticket-port/board-filed-row.ts"; // #5405: the card is added only when it is not on the board yet; #1369 shares this write with the outside-idle triage row
import { rows } from "./plugins/rows.ts"; // #5039: the incident rows are read without search (the code host reads them); A11-160, step 9: so is everything else this file asks of GitHub
import type { RecentRunRead, SharedFailureRowRead } from "./plugins/contracts/code-host-rows-classes.ts";
import { decide, MAX_STATE_BYTES, type DecisionDeps, type Question } from "./decision-provider.ts";
import { CI_CLASS, ERROR_LINE, FAILING_ASSERTION, LOG_LINES_KEPT, LOG_TIMESTAMP, NOT_THE_FAILURE, rateLimitOrLostRunner, READS_OUTSIDE, withoutColour } from "./ci-log-lines.ts";

// The log readers every consumer of this file has always imported from it live in `ci-log-lines.ts`, a leaf that reads no project declaration (A11-154).
export { CI_CLASS, ERROR_LINE, LOG_TIMESTAMP, NOT_THE_FAILURE, rateLimitOrLostRunner, READS_OUTSIDE };

export const CI_FAILURE_CLASSES = Object.freeze(["own-defect", "flaky", "another-repository-changed", "infrastructure", "stale-merge-ref"] as const);
export type CiFailureClass = (typeof CI_FAILURE_CLASSES)[number];
const CI_FAILURE_ROUTES = Object.freeze(["owner", "rerun-once", "cross-repo-incident", "rerun-after-reset", "push-or-update-branch"] as const);
type CiFailureRoute = (typeof CI_FAILURE_ROUTES)[number];

/** At most this many error lines are sent, so the state stays a few fields and never a log. */
export const MAX_ERROR_LINES = 40;
const MAX_LINE_CHARS = 160;
/** Room left under the decision seam's own state limit for the fields that are not error lines. */
const FACTS_HEADROOM_BYTES = 512;
const QUESTION = "class";
const INSTRUCTIONS = "A pull request's CI check is red. From the failing test's error lines and the facts, which class is the failure?";

/** What is known about one red check. The four booleans are computed in code; `rerunAlready` is whether this run was already rerun once. */
type CiFailureFacts = {
  /** The same test is red on `main` at the same time. */
  redOnMain: boolean;
  /** The same test is red on other open pull requests at the same time. */
  redOnOtherPrs: boolean;
  /** The test reads outside its repository (another repository's checkout, the network, the host). */
  readsOutsideRepository: boolean;
  /** The error text is a rate limit or a runner that was lost. */
  rateLimitOrRunnerLost: boolean;
  rerunAlready: boolean;
  /**
   * agent-org#1524: the acceptance gate could not read the diff, because the merge commit the run checked out has no parents (a superseded merge). A rerun checks out that same
   * commit, so it cannot clear it. Absent is `false`, so a caller that does not read it is today's classifier.
   */
  staleMergeRef?: boolean;
};
export type CiFailure = CiFailureFacts & { errorLines: readonly string[] };
type CiFailureDecision = {
  klass: CiFailureClass;
  route: CiFailureRoute;
  /** `jev` when the provider chose the class, else `none`. */
  via: "jev" | "none";
  /** The provider's answer was replaced by the rule (or never asked); `reason` says why. */
  fellBack: boolean;
  reason?: string;
  confidence?: number;
};

/** The class of a run that checked out a superseded merge commit (agent-org#1524). Offered to the provider only when {@link CiFailureFacts.staleMergeRef} was READ true. */
const STALE_REF = "stale-merge-ref" satisfies CiFailureClass;

const CRITERIA: Readonly<Record<CiFailureClass, string>> = Object.freeze({
  "own-defect": "the failure comes from this pull request's own change: the error names code or a test it touched and nothing else explains it.",
  flaky: "the test passes and fails without a change: a timing, ordering or race error, red on this pull request alone and not on main.",
  "another-repository-changed": "the test reads another repository or a pinned dependency, and that repository changed: the same test is red on main or on other pull requests.",
  infrastructure: "the runner, the network or a rate limit failed, whatever the code did.",
  [STALE_REF]: "the acceptance gate could not read the diff because the merge commit the run checked out is a superseded one with no parents: the pull request's own change is not what failed, and a rerun checks out the same commit.",
});

const ROUTES: Readonly<Record<CiFailureClass, CiFailureRoute>> = Object.freeze({
  "own-defect": "owner",
  flaky: "rerun-once",
  "another-repository-changed": "cross-repo-incident",
  infrastructure: "rerun-after-reset",
  [STALE_REF]: "push-or-update-branch",
});

/**
 * THE RULE WITH NO PROVIDER. A rate-limit or runner-lost text is infrastructure FIRST, because a runner lost on `main` too is still not a repository that changed; the same test red on
 * `main` is another repository's change; everything else is the pull request's own defect, which is today's order unchanged.
 * A superseded merge commit the acceptance gate could not read is {@link STALE_REF} (#1524): after the runner, before `main`, since `main` being red says nothing about it.
 */
export function fallbackClass(facts: Pick<CiFailureFacts, "redOnMain" | "rateLimitOrRunnerLost" | "staleMergeRef">): CiFailureClass {
  if (facts.rateLimitOrRunnerLost) return "infrastructure";
  if (facts.staleMergeRef === true) return STALE_REF;
  return facts.redOnMain ? "another-repository-changed" : "own-defect";
}

/** The class's route. A flaky failure is rerun ONCE: one already rerun goes to its owner, never a second rerun. */
export function routeFor(klass: CiFailureClass, { rerunAlready }: { rerunAlready: boolean; }): CiFailureRoute {
  return klass === "flaky" && rerunAlready ? ROUTES["own-defect"] : ROUTES[klass];
}

/** The first non-blank lines with colour codes removed and each line cut, kept under {@link MAX_ERROR_LINES} and the bytes the seam allows beside the facts. */
export function trimErrorLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let bytes = FACTS_HEADROOM_BYTES;
  for (const raw of lines) {
    const line = withoutColour(raw).trim().slice(0, MAX_LINE_CHARS);
    if (line === "") continue;
    bytes += Buffer.byteLength(JSON.stringify(line)) + 1;
    if (kept.length >= MAX_ERROR_LINES || bytes > MAX_STATE_BYTES) break;
    kept.push(line);
  }
  return kept;
}

const stateOf = (failure: CiFailure, errorLines: readonly string[]) => ({
  errorLines,
  redOnMain: failure.redOnMain,
  redOnOtherPrs: failure.redOnOtherPrs,
  readsOutsideRepository: failure.readsOutsideRepository,
  rateLimitOrRunnerLost: failure.rateLimitOrRunnerLost,
  ...(failure.staleMergeRef === true ? { staleMergeRef: true } : {}),
});

/** The classes the provider may pick: {@link STALE_REF} only when its fact was read, so a provider cannot route an ordinary red to a push. */
const criteriaFor = (failure: CiFailure): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(CRITERIA).filter(([klass]) => klass !== STALE_REF || failure.staleMergeRef === true));

const isClass = (value: unknown, failure: CiFailure): value is CiFailureClass =>
  typeof value === "string" && Object.hasOwn(criteriaFor(failure), value);

/**
 * CLASSIFY ONE RED CHECK AND NAME WHERE IT GOES. Never throws and always returns a class: the provider's when it answered at or over the floor, {@link fallbackClass} otherwise.
 * `deps` is `decide`'s (the host, the switches, the log); pass `id` (the causeKey) so `recordOutcome` can later say whether the class was right.
 */
export async function classifyCiFailure(failure: CiFailure, deps: DecisionDeps): Promise<CiFailureDecision> {
  const fallback = fallbackClass(failure);
  const question: Question = { type: "choice", instructions: INSTRUCTIONS, criteria: criteriaFor(failure), fallback };
  const state = stateOf(failure, trimErrorLines(failure.errorLines));
  const decision = await decide("ci-failure-class", state, { [QUESTION]: question }, deps);
  const answer = decision.answers[QUESTION];
  // The seam checks a choice against the criteria, so this is the belt to its braces: a value that is no class is the rule's.
  const klass = isClass(answer.value, failure) ? answer.value : fallback;
  return {
    klass,
    route: routeFor(klass, { rerunAlready: failure.rerunAlready }),
    via: decision.via,
    fellBack: decision.fellBack,
    ...(answer.reason === undefined && decision.reason === undefined ? {} : { reason: answer.reason ?? decision.reason }),
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
  };
}

/** The line the order and the decision log carry: the class, the route and who chose. */
export const classLine = (d: CiFailureDecision): string => `CI failure class: ${d.klass} -> ${d.route} (${d.via === "jev" ? "provider" : "rule"}${d.reason === undefined ? "" : `: ${d.reason}`})`;

// ---------------------------------------------------------------------------------------------------
// THE FACTS (#4888). Read from GitHub by CODE and handed to {@link classifyCiFailure} as state. Every read is REST (`gh api`, the core pool the gate does not lean on), a failed read is
// `null` -- "could not determine", never "not red" -- and the caller then sends today's order unchanged.

/** The code host's program, as an injected seam: the arguments, the stdout back. The code host's operations below are run on it. */
export type Gh = (args: string[]) => string;
/** The pull request a red order is about: `repo` is `owner/name`, and `head8` is the head the order's cause key carries. */
type RedPullRequest = { repo: string; number: number; head8: string };

/** A run this recent counts as "at the same time". A red `main` from last week is a different failure. */
const SAME_TIME_MS = 6 * 60 * 60 * 1000;
const RUNS_LISTED = 50;
const MAIN_RUNS_LISTED = 10;
const MAX_ASSERTIONS_NAMED = 5;
/**
 * agent-org#1185: THE FAILING ASSERTION LINES of a failure, for the order a same-head re-fail sends. Only the lines that say a TEST failed ({@link FAILING_ASSERTION}), so a passing
 * test's printed "rate limit" is not quoted; and when the log names no test (a step that failed before any ran) the first error lines are the best the log has, never nothing.
 */
export function failingAssertionLines(errorLines: readonly string[]): string[] {
  const named = errorLines.filter((line) => FAILING_ASSERTION.test(line));
  return (named.length > 0 ? named : errorLines.filter((line) => !NOT_THE_FAILURE.test(line))).slice(0, MAX_ASSERTIONS_NAMED).map((line) => line.trim());
}
// agent-org#1524: the acceptance gate's own words when the merge commit it checked out has no parents, so the diff cannot be read. Both lines it prints say "could not read the diff".
const STALE_MERGE_REF = /the diff could not be read|could not read the diff/;

type WorkflowRun = RecentRunRead;

const recent = (run: WorkflowRun, now: number): boolean => now - Date.parse(String(run.updatedAt)) <= SAME_TIME_MS;

/** Is the newest run of `workflow` on `main` red, and recent? The newest only: a green run since then is a repair. */
function redOnMainNow(runs: readonly WorkflowRun[], workflow: string, now: number): boolean {
  const newest = runs.find((run) => run.name === workflow);
  return newest !== undefined && newest.conclusion === "failure" && recent(newest, now);
}

/** Does another branch's recent run of `workflow` fail too? Compared by BRANCH, because a fork's run carries no pull request number. */
function redOnOtherPrsNow(runs: readonly WorkflowRun[], { workflow, branch, now }: { workflow: string; branch: string; now: number }): boolean {
  return runs.some((run) => run.name === workflow && run.conclusion === "failure" && run.headBranch !== branch && run.headBranch !== "main" && recent(run, now));
}

/**
 * THE FACTS OF ONE RED PULL REQUEST, or `null` when they could not be read or there is nothing red at the head the order names (the head moved, or the red check is not an Actions job).
 * The first failing check that is not the roll-up `gate` is the one classified (the roll-up's log names no cause, #5151): a pull request with several red checks is told about the first,
 * and the order's own text still lists them all.
 * @param now an injected clock, so "at the same time" is testable
 * @param flags {@link CI_CLASS}: the rate-limit read of the failing assertions (#1166); the default is today's read of the whole log
 */
export function readCiFailure({ repo, number, head8 }: RedPullRequest, gh: Gh, now: number = Date.now(), flags: { assertionsOnly: boolean } = CI_CLASS): CiFailure | null {
  const red = rows().redCheckOf({ repo, number, head8, run: gh });
  if (red === null) return null;
  // An Actions log carries colour codes, and the log read allows them (#767: without the flag the read never returned and no class was ever asked). The escapes are stripped HERE, once, so a coloured `##[error]`
  // is matched by `ERROR_LINE` and `RATE_LIMIT_OR_RUNNER_LOST` as the plain line it is.
  const log = withoutColour(red.log);
  const errorLines = log.split("\n").filter((line) => ERROR_LINE.test(line)).slice(-LOG_LINES_KEPT);
  const onMain = rows().recentRunsOf({ repo, kind: "on-main", limit: MAIN_RUNS_LISTED, run: gh });
  const failing = rows().recentRunsOf({ repo, kind: "failing-for-pull-requests", limit: RUNS_LISTED, run: gh });
  return {
    errorLines,
    redOnMain: redOnMainNow(onMain, red.workflow, now),
    redOnOtherPrs: redOnOtherPrsNow(failing, { workflow: red.workflow, branch: red.branch, now }),
    readsOutsideRepository: errorLines.some((line) => READS_OUTSIDE.test(line)),
    rateLimitOrRunnerLost: rateLimitOrLostRunner(log, flags),
    rerunAlready: red.runAttempt > 1,
    // present only when true, for the same reason (#1524): read from the whole log, where the acceptance gate's line is
    ...(STALE_MERGE_REF.test(log) ? { staleMergeRef: true } : {}),
  };
}

const ROUTE_WORDS: Readonly<Record<CiFailureRoute, string>> = Object.freeze({
  owner: "The failure is this pull request's own: fixing it is yours.",
  "rerun-once": "A flaky failure: rerun the failed job ONCE (`gh run rerun <run id> --failed`); red again, it is your defect.",
  "cross-repo-incident": "Another repository or a pinned dependency changed: this is not this pull request's defect, so do not fix it here; file or join the cross-repository incident for the cause.",
  "rerun-after-reset": "The runner or a rate limit failed, not the code: change nothing; rerun the failed job after the limit resets.",
  "push-or-update-branch": "The merge commit this run checked out is a superseded one, not your change: re-push the branch or update it (`update-branch`) so GitHub builds a new merge commit; a rerun reuses the same merge commit and cannot clear it.",
});

/**
 * Does the order gain {@link classNote}: always when the PROVIDER chose, and when a RULE chose only for a route whose reader would otherwise act wrongly: the route that tells a holder a rerun
 * cannot clear the red (#1524). Every other rule's class is the gate's own order already ("fix it"), so a note would repeat it.
 */
export const notesTheOrder = (decision: CiFailureDecision): boolean =>
  decision.via === "jev" || decision.route === "push-or-update-branch";

/** What the order's text gains when {@link notesTheOrder}: the line, and what the route asks of its reader. */
export function classNote(decision: CiFailureDecision): string {
  return `${classLine(decision)}. ${ROUTE_WORDS[decision.route]}`;
}

// ---------------------------------------------------------------------------------------------------
// A FAILURE SHARED BY MANY PULL REQUESTS IS ONE INCIDENT (a11ign#5008). The four classes above are PER pull request, so the same broken setup step (#4988: the agent-org tool install) woke
// every red PR's worker and two of them diagnosed it separately; and when its fix merged nothing re-ran the red PRs, because a re-run tests the OLD merge commit.
//
//   1. {@link holdSharedFailures}: red orders whose failing check, failing step and first error line MATCH across two or more open PRs are HELD -- nothing is written, as
//      `holdForGithubIncident` does it -- and ONE incident row is filed or joined ({@link recordIncident}), its body listing the PRs. A PR with any red check that is NOT shared still goes
//      out as today, and so does one whose log could not be read (ABSENCE IS NOT PROOF).
//      WHAT "SHARED" MEANS (#5098): the failure is OUTSIDE every PR's diff. A setup or install step is (the runner and the registry are not the PR's); anything else is shared only when
//      both PRs fail in ONE file that NEITHER changes (nor changes the source its test covers). The roll-up job (`gate`) is never read: it is red whenever any job is, and says nothing.
//   1b. {@link standingOf}: a hold is not a state, it is a reading of the incident row. A CLOSED row releases its holds at once and its signature stays quiet for {@link QUIET_AFTER_CLOSE_MS}
//      unless a PR the row never named joins; an OPEN row holds its pull requests until it closes, claimed or not (#1557: the 15-minute release woke every held worker at once for a row nobody had claimed),
//      and an unclaimed one past {@link HOLD_MAX_MS} is named in the gate's log so the one line says who is waiting. A released order carries the failing job's own line.
//   2. {@link refreshFixed}: when the pull request closing an incident row has MERGED, every PR it notes is updated from main (`PUT /pulls/{n}/update-branch`), so CI runs against the fix
//      with no worker turn. A refusal (a conflict) is written on the row as `Refresh-failed:`, which stops that PR being held: its worker gets the order again.
//   3. The detector: an open PR whose red check failed BEFORE the fix merged, named like the incident's check, and still behind 10 minutes after the merge, is read, and refreshed
//      and noted on the row when its failure matches the incident's.
// THE ROW IS THE STATE: nothing is kept in a file. Every read that is refused leaves today's behaviour.

export const SHARED_FAILURE_LABEL = "ci-shared-failure";
/** A fix this young is still the notified PRs' to refresh; the detector waits this long before it takes a PR nobody noted. */
const REFRESH_GRACE_MS = 10 * 60 * 1000;
const MAX_SIGNATURE_READS = 12;
const MAX_INCIDENT_ROWS = 20;
/** The runner's own steps: a failure here is never the PR's diff, so ONE PR in one is enough. */
const RUNNER_SETUP_STEP = /^(set up job|initialize containers|complete job|checkout|run actions\/checkout)/i;
/** Plus the steps that fetch what the PR did not write (the agent-org tool install, #4988): two PRs failing one of these the same way share it. */
const SETUP_STEP = /^(set up|setup|install|initialize containers|complete job|post |checkout|run actions\/|download|restore|cache)/i;
/** The roll-up job reports OTHER jobs' results, so its failure is every failure's echo: it names no cause (#5098). By name, by step, and by the line its script prints. */
const AGGREGATOR_CHECK = /(^|[\s/])gate$/i;
const AGGREGATOR_STEP = /^every job (?:that )?ran\b/i;
const AGGREGATOR_LINE = /##\[group\]Run for result in|\ba job reported\b|\breported '[^']*', not success/;
/** What a test runner prints for the test that failed, which names the file: rstest/vitest `FAIL file > name`, TAP `not ok`. */
const TEST_FAILURE = /^(?:##\[error\]|FAIL\b|not ok\b)/;
const FILE_WINDOW_LINES = 30;
const SOURCE_FILE = /((?:[\w@.-]+\/)*[\w@.-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|rb|go|rs|sh|ya?ml|json))\b/;
/** An OPEN incident row older than this with no claim is named in the gate's log (#1557). It does NOT release its holds: a hold waits for the row to close. */
const HOLD_MAX_MS = 15 * 60 * 1000;
/** A closed incident's signature is not filed again for this long, unless a PR the row never named joins it. */
const QUIET_AFTER_CLOSE_MS = 24 * 60 * 60 * 1000;
const CHANGED_FILES_PAGE = 100;
const SIGNATURE_NOISE: readonly [RegExp, string][] = [
  [/\d{4}-\d\d-\d\dT[\d:.]+Z\s*/g, ""], [/##\[error\]/g, ""], [/\b[0-9a-f]{7,40}\b/g, "<sha>"], [/\/home\/runner\/work\/\S*/g, "<path>"], [/\d+/g, "#"],
];

export type Run = (args: string[]) => string;
/** One red Actions check of an open pull request, as the rollup carries it. */
export type RedCheck = { name: string; detailsUrl: string; completedAt?: string };
/** An open pull request with red checks: `ref` is the order's own subject (`pr-7`, `pr-agent-org#7`), `repo` is `owner/name`. */
export type RedPr = { ref: string; repo: string; number: number; checks: RedCheck[]; headBehind?: boolean };
/** `file` is the source file the failure names (`null` when the log names none): it decides whether a match is outside the PR's diff, so it is part of the key unless the step is setup. */
export type FailureSignature = { check: string; step: string; line: string; file: string | null };

const normalise = (line: string): string => SIGNATURE_NOISE.reduce((text, [pattern, to]) => text.replace(pattern, to), withoutColour(line)).trim().slice(0, MAX_LINE_CHARS);
const isSetup = (signature: FailureSignature): boolean => SETUP_STEP.test(signature.step);
/** The key two failures share when they are the same failure. A setup step's file is incidental (a path in an npm error), so only another step's file is part of it. */
const signatureKey = (signature: FailureSignature): string =>
  `${signature.check} | ${signature.step} | ${signature.line}${isSetup(signature) || signature.file === null ? "" : ` | ${signature.file}`}`;
const isAggregator = (check: Pick<RedCheck, "name">): boolean => AGGREGATOR_CHECK.test(check.name);
/** The checks that can name a cause: the roll-up is left out. */
const causes = (pr: RedPr): RedCheck[] => pr.checks.filter((check) => !isAggregator(check));

/** The log line that IS the failure: a test runner's or an `##[error]` line first, else the first error-looking line that is not a warning or an echoed command (#5098). */
function failureLine(lines: readonly string[]): number {
  const text = (line: string) => line.replace(LOG_TIMESTAMP, "").trim();
  const plausible = lines.map((line, at) => [at, text(line)] as const).filter(([, line]) => ERROR_LINE.test(line) && !NOT_THE_FAILURE.test(line));
  const named = plausible.find(([, line]) => TEST_FAILURE.test(line)) ?? plausible[0];
  return named?.[0] ?? lines.findIndex((line) => ERROR_LINE.test(line));
}

/** The first source file named from the failing line on, as the repository writes it (the runner's checkout prefix and any `:line:col` removed); `null` when none is named. */
function failingFile(lines: readonly string[], from: number): string | null {
  for (const line of lines.slice(from, from + FILE_WINDOW_LINES)) {
    const found = SOURCE_FILE.exec(line.replace(LOG_TIMESTAMP, ""))?.[1];
    if (found === undefined || found.includes("node_modules/")) continue;
    return found.replace(/^.*?\/work\/[^/]+\/[^/]+\//, "").replace(/^\.\//, "");
  }
  return null;
}

/**
 * The failing step and the failing line of one job, or `null` when either read was refused, the job has no failed step, or it is a ROLL-UP (it reports other jobs, so it has no
 * failure of its own). Normalised, so two runs compare equal.
 */
export function readSignature(check: RedCheck, run: Run): FailureSignature | null {
  const job = rows().jobOfCheckUrl(check.detailsUrl);
  if (job === null || isAggregator(check)) return null;
  try {
    const failedStep = rows().jobFailedStepOf({ ...job, run });
    if (failedStep === null || AGGREGATOR_STEP.test(failedStep)) return null;
    const lines = withoutColour(rows().jobLogTextOf({ ...job, run })).split("\n");
    const at = failureLine(lines);
    if (at < 0 || AGGREGATOR_LINE.test(lines[at])) return null;
    return { check: check.name, step: failedStep, line: normalise(lines[at]), file: failingFile(lines, at) };
  } catch {
    return null; // a refused read: UNCLASSIFIED, never "shared"
  }
}

/** `prs` are the orders' subjects; `noted` the same pull requests as `owner/name#n`, which is how an incident row names them. */
export type SharedGroup = { key: string; signature: FailureSignature; prs: string[]; noted: string[] };
export const notedAs = (pr: Pick<RedPr, "repo" | "number">): string => `${pr.repo}#${pr.number}`;

/** Does this failing file belong to what the PR changed: the file itself, or the source/test beside it (`foo.ts` and `foo.test.ts` cover each other)? */
export function touchesDiff(file: string, changed: readonly string[]): boolean {
  const bare = (path: string) => path.replace(/\.(?:test|spec)(?=\.[^./]+$)/, "");
  const same = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  return changed.some((path) => same(bare(path), bare(file)));
}

/**
 * THE GROUPS OF THE TICK. A check name red on two or more of `prs` is read (one job each, at most {@link MAX_SIGNATURE_READS}); a group is the PRs whose signature key is equal and which
 * number two or more, or one PR whose failing step is the runner's own setup. A PR is in a group only when EVERY one of its red checks is (a second, own failure sends its order).
 *
 * #5098: THE FAILURE MUST BE OUTSIDE THE DIFF. A setup step is. Any other step is shared only when its signature names a file, `changedOf` could read every PR's changed files, and
 * none of them touches that file; a PR that does is left out, so a group of one is no group. The roll-up check is not one of a PR's red checks at all.
 */
export function sharedFailureGroups(
  prs: readonly RedPr[], read: (check: RedCheck) => FailureSignature | null, changedOf: (pr: RedPr) => readonly string[] | null = () => null,
): SharedGroup[] {
  let reads = 0;
  const keyed = new Map<string, { signature: FailureSignature; prs: Set<string> }>();
  const unshared = new Set<string>();
  for (const pr of prs) {
    for (const check of causes(pr)) {
      const signature = reads < MAX_SIGNATURE_READS ? (reads++, read(check)) : null;
      if (signature === null) { unshared.add(pr.ref); continue; }
      const group = keyed.get(signatureKey(signature)) ?? { signature, prs: new Set<string>() };
      group.prs.add(pr.ref);
      keyed.set(signatureKey(signature), group);
    }
  }
  const byRef = new Map(prs.map((pr) => [pr.ref, pr]));
  const outsideDiff = (signature: FailureSignature, refs: Set<string>): string[] => [...refs].filter((ref) => {
    if (isSetup(signature)) return true;
    const changed = signature.file === null ? null : changedOf(byRef.get(ref)!);
    return signature.file !== null && changed !== null && !touchesDiff(signature.file, changed);
  });
  const shared = [...keyed.entries()].map(([key, g]) => ({ key, signature: g.signature, refs: outsideDiff(g.signature, g.prs) }))
    .filter((g) => g.refs.length >= 2 || (g.refs.length === 1 && RUNNER_SETUP_STEP.test(g.signature.step)));
  const sharedRefs = new Map<string, number>();
  for (const g of shared) for (const ref of g.refs) sharedRefs.set(ref, (sharedRefs.get(ref) ?? 0) + 1);
  const redCount = new Map(prs.map((pr) => [pr.ref, causes(pr).length]));
  const whole = (ref: string) => !unshared.has(ref) && (sharedRefs.get(ref) ?? 0) === redCount.get(ref);
  const noted = new Map(prs.map((pr) => [pr.ref, notedAs(pr)]));
  return shared.map((g) => ({ key: g.key, signature: g.signature, prs: g.refs.filter(whole) }))
    .filter((g) => g.prs.length > 0).map((g) => ({ ...g, noted: g.prs.map((ref) => noted.get(ref)!) }));
}

/** Filter-cheap: only a PR with a red check name that is red on two PRs is worth a log read (whether ALL its red checks are shared is decided after). A lone red PR costs no read, so a lone setup failure is today's order. The roll-up is no check. */
const candidates = (prs: readonly RedPr[]): RedPr[] => {
  const seen = new Map<string, number>();
  for (const pr of prs) for (const name of new Set(causes(pr).map((c) => c.name))) seen.set(name, (seen.get(name) ?? 0) + 1);
  return prs.filter((pr) => causes(pr).some((c) => (seen.get(c.name) ?? 0) >= 2));
};

/** The files a pull request changes, or `null` when the read was refused or the page is full (a truncated list proves nothing about a file it does not show). */
function changedFiles(pr: RedPr, run: Run): string[] | null {
  try {
    const files = rows().changedFilesPageOf({ repo: pr.repo, number: pr.number, perPage: CHANGED_FILES_PAGE, run });
    return files !== null && files.length < CHANGED_FILES_PAGE ? files : null;
  } catch {
    return null; // a refused read: the diff is UNKNOWN, so the failure is not shown to be outside it
  }
}

type HeldOrder = { subject: string; session: string; key: string };
type ReleasedOrder = { subject: string; session: string; key: string; why: "closed" | "unrecorded"; line: string };
/**
 * What the rows say about a group: hold it (no row yet, or an open row), or release it because its row was closed or could not be filed (a hold with no row behind it is
 * exactly the hold #5098 forbids).
 */
type Standing = { hold: true } | { hold: false; why: ReleasedOrder["why"]; row?: number };
type OrderLike = { cause?: string; subject?: string; session?: string; discriminator?: string; prompt?: string };

const RELEASE_REASON: Readonly<Record<ReleasedOrder["why"], string>> = {
  closed: "its incident row was closed",
  unrecorded: "its incident row could not be filed",
};
const releasedWords = (group: SharedGroup, standing: Extract<Standing, { hold: false }>): string =>
  `SHARED-FAILURE HOLD RELEASED (${standing.row === undefined ? "" : `#${standing.row}: `}${RELEASE_REASON[standing.why]}): this red is NOT being held for an incident, so it is yours to read. `
  + `The failing job \`${group.signature.check}\`, step \`${group.signature.step}\`, says: ${group.signature.line}`;

/**
 * HOLD, DO NOT WAKE: the settled-red `pr-checks-failing` orders of a shared failure are withheld and everything else goes out unchanged. `refused` are the PRs whose refresh was refused,
 * which are never held again. `standing` is what the incident rows say about a group (absent: hold it); a RELEASED group's orders go out carrying the failing job's own line (#5098).
 * Pure given `run`.
 */
export function holdSharedFailures<O extends OrderLike>(
  orders: readonly O[], { prs, run, refused = [], standing = () => ({ hold: true }) }: { prs: readonly RedPr[]; run: Run; refused?: readonly string[]; standing?: (group: SharedGroup) => Standing },
): { orders: O[]; held: HeldOrder[]; released: ReleasedOrder[]; groups: SharedGroup[] } {
  const ordered = new Set(orders.filter((o) => o.cause === "pr-checks-failing" && o.discriminator !== "hung-check" && o.discriminator !== "ejected").map((o) => o.subject));
  const open = candidates(prs.filter((pr) => ordered.has(pr.ref)));
  const released = new Set(prs.filter((pr) => refused.includes(notedAs(pr))).map((pr) => pr.ref));
  const changed = new Map<string, string[] | null>();
  const changedOf = (pr: RedPr) => (changed.has(pr.ref) ? changed : changed.set(pr.ref, changedFiles(pr, run))).get(pr.ref)!;
  const groups = sharedFailureGroups(open, (check) => readSignature(check, run), changedOf);
  const standings = new Map<string, Standing>();
  const standingFor = (group: SharedGroup): Standing => standings.get(group.key) ?? standings.set(group.key, standing(group)).get(group.key)!; // asked once, and only of a group with an order to decide
  const groupOf = new Map(groups.flatMap((g) => g.prs.filter((ref) => !released.has(ref)).map((ref) => [ref, g] as const)));
  const held: HeldOrder[] = [];
  const freed: ReleasedOrder[] = [];
  const kept = orders.flatMap((o): O[] => {
    const group = o.cause === "pr-checks-failing" ? groupOf.get(String(o.subject)) : undefined;
    if (group === undefined) return [o];
    const verdict = standingFor(group);
    if (verdict.hold) { held.push({ subject: String(o.subject), session: String(o.session), key: group.key }); return []; }
    freed.push({ subject: String(o.subject), session: String(o.session), key: group.key, why: verdict.why, line: group.signature.line });
    return [{ ...o, prompt: `${o.prompt === undefined ? "" : `${o.prompt}\n\n`}${releasedWords(group, verdict)}` }];
  });
  return { orders: kept, held, released: freed, groups };
}

// ---- the incident row
const hashOf = (key: string): string => {
  let h = 0;
  for (const ch of key) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0");
};
const markerOf = (key: string): string => `<!-- ${SHARED_FAILURE_LABEL}:${hashOf(key)} -->`;
const PRS_LINE = /^Shared-failure-prs: (.*)$/m;
const FAILED_LINE = /^Refresh-failed: (.*)$/m;
const REFRESHED_LINE = /^Refreshed-at: /m;
const CHECK_LINE = /^Check: (.*)$/m;
const listOf = (body: string, line: RegExp): string[] => (line.exec(body)?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");

type IncidentRow = SharedFailureRowRead;
/**
 * #5039: THE INCIDENT ROWS, READ WITHOUT SEARCH (see rows-by-label.ts), and a FAILED READ THROWS: it used to answer `[]`, which read as "no
 * incident row", so a tick that could not list them filed a second row for the same failure. The two callers that file or join catch it.
 */
export const readRows = (run: Run, state: "open" | "closed"): IncidentRow[] =>
  rows().sharedFailureRowsOf({ label: SHARED_FAILURE_LABEL, state, newest: MAX_INCIDENT_ROWS, run });

/**
 * WHAT THE ROWS SAY ABOUT `group` (#5098). The hold used to be recomputed from the live reds every tick, so closing the row released nothing: the same signature matched again, no OPEN
 * row carried its marker, and a fresh row was filed. A hold is now a reading of the row: an OPEN row holds until it closes, whatever its age and whether or not it is claimed (#1557: an
 * unclaimed row released every held worker at 15 minutes, which is the wake-up this file exists to stop). A row CLOSED within {@link QUIET_AFTER_CLOSE_MS} releases at once, unless a PR
 * it never named has joined.
 */
export function standingOf(group: SharedGroup, { open, closed, nowMs }: { open: readonly IncidentRow[]; closed: readonly IncidentRow[]; nowMs: number }): Standing {
  const marker = markerOf(group.key);
  if (open.some((r) => r.body.includes(marker))) return { hold: true };
  const quiet = closed.find((r) => r.body.includes(marker) && nowMs - Date.parse(String(r.closedAt)) < QUIET_AFTER_CLOSE_MS
    && group.noted.every((ref) => listOf(r.body, PRS_LINE).includes(ref)));
  return quiet === undefined ? { hold: true } : { hold: false, why: "closed", row: quiet.number };
}

const bodyOf = (group: SharedGroup, prs: readonly string[]): string => [
  `A failure shared by ${prs.length} open pull request(s), found by the gate: one incident, and the workers of these PRs are not woken for it.`, "",
  "SIGNAL for `orchestrator`: the pull requests this row names are HELD until it closes, so the fix to the shared failure is the work. It is on the board at Backlog so the failure is visible and can be routed.", "",
  `Check: ${group.signature.check}`, `Step: ${group.signature.step}`, `First error line: ${group.signature.line}`, "",
  `Shared-failure-prs: ${prs.join(", ")}`, "",
  "When the pull request that closes this row MERGES, the gate updates each PR above from main so CI runs against the fix. Close this row with the fix's `Closes`.", markerOf(group.key),
].join("\n");

// #5405: THE INCIDENT ROW IS ON THE BOARD WHEN IT IS FILED. A bare `gh issue create` left it off Project 1, where `row-off-board` trips on it and nothing can board it. Order is
// row-file's: the card, then its Status, then the labels LAST, so a row that carries `out-of-release` is one whose Status was already set.
// A RETRY AFTER A PARTIAL BOARD: the card may already be on Project 1 (item-add landed, the Status did not). The card is added only when the issue is NOT on the board at
// all -- a second item-add is refused or duplicates it, and `isIssueOnBoard` is the read that tells "absent" from "on it with no Status". An unreadable board throws: the next tick retries.
const BOARD_STATUS = "Backlog";
function boardIncident(number: number, run: Run): void {
  boardFiledRow({ repo: REPO, number, owner: PROJECT_OWNER, projectNumber: PROJECT_NUMBER, status: BOARD_STATUS, labels: [BACKLOG_LABEL, OUT_OF_RELEASE_LABEL], run });
}

/** A row filed before #5405, or one whose boarding was refused, carries no release declaration: board it now. The row exists, so a refusal is logged, not thrown. Returns `false` when the board was refused. */
function healBoard(row: IncidentRow, run: Run, log: (line: string) => void): boolean {
  if (row.labels?.includes(OUT_OF_RELEASE_LABEL)) return true;
  try {
    boardIncident(row.number, run);
    return true;
  } catch (error) {
    log(`ci-shared-failure: could not board #${row.number} (${String((error as Error).message).split("\n")[0]}); the next tick retries\n`);
    return false;
  }
}

/** Files the incident row and boards it. A refused board throws, so the row is NOT reported filed: the next tick finds it by its marker and boards it then. */
function fileIncident(group: SharedGroup, run: Run): number | null {
  const title = `CI failure shared by ${group.prs.length} PRs: ${group.signature.check}: ${group.signature.line}`.slice(0, 120);
  const number = rows().fileSharedFailureRow({ label: SHARED_FAILURE_LABEL, description: "One CI failure shared by several open pull requests", title, body: bodyOf(group, group.noted), run });
  if (number !== null) boardIncident(number, run);
  return number;
}

/** File the incident row for `group`, or add its PRs to the open one. Returns the row number, or `null` when `gh` refused (the next tick retries). */
export function recordIncident(group: SharedGroup, { run, log }: { run: Run; log: (line: string) => void }): number | null {
  try {
    const found = readRows(run, "open").find((row) => String(row.body).includes(markerOf(group.key)));
    if (found === undefined) return fileIncident(group, run);
    const noted = listOf(found.body, PRS_LINE);
    const merged = [...new Set([...noted, ...group.noted])];
    if (merged.length !== noted.length) rows().setRowBody({ number: found.number, body: bodyOf(group, merged), run });
    // #5405: a row whose board was refused is NOT filed: the caller is told so, and the next tick joins it and boards it.
    if (!healBoard(found, run, log)) return null;
    return found.number;
  } catch (error) {
    log(`ci-shared-failure: could not file or join the incident for ${group.key} (${String((error as Error).message).split("\n")[0]}); the next tick retries\n`);
    return null;
  }
}

// ---- the refresh
/** `PUT update-branch` for one pull request, `true` when GitHub accepted it, `false` when it refused (a conflict) -- never throws. */
function updateBranch(repo: string, number: number, run: Run): boolean {
  try {
    rows().updatePullBranch({ repo, number, run });
    return true;
  } catch {
    return false;
  }
}
const parseRef = (ref: string): { repo: string; number: number } | null => {
  const m = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(ref);
  return m === null ? null : { repo: m[1], number: Number(m[2]) };
};

/**
 * THE FIX REFRESHES ITS VICTIMS. Each closed incident row not yet `Refreshed-at` whose closing pull request
 * merged is handled once: its noted PRs, still open and behind, are updated; a refusal is written as `Refresh-failed:`; then the row is stamped. Returns what was refreshed and what refused.
 */
export function refreshFixed({ run, log, nowMs = Date.now(), open = [] }: {
  run: Run; log: (line: string) => void; nowMs?: number; open?: readonly RedPr[];
}): { refreshed: string[]; refused: string[] } {
  const refreshed: string[] = [];
  const refused: string[] = [];
  for (const row of readRows(run, "closed").filter((r) => !REFRESHED_LINE.test(String(r.body)))) {
    const mergedAt = mergedFixAt(row, run);
    if (mergedAt === null) continue;
    const noted = listOf(row.body, PRS_LINE);
    const late = nowMs - mergedAt >= REFRESH_GRACE_MS ? lateVictims(row, { open, mergedAt, run }).filter((ref) => !noted.includes(ref)) : [];
    const failed: string[] = [];
    for (const ref of [...noted, ...late]) {
      const parsed = parseRef(ref);
      if (parsed === null) continue;
      if (!stillOpenAndBehind(parsed.repo, parsed.number, run)) continue;
      (updateBranch(parsed.repo, parsed.number, run) ? refreshed : failed).push(ref);
    }
    refused.push(...failed);
    stamp(row, { late, failed, run, log, nowMs });
  }
  return { refreshed, refused };
}

const mergedFixAt = (row: IncidentRow, run: Run): number | null => {
  for (const pr of row.closedBy) {
    try {
      const mergedAt = rows().pullMergedAtOf({ repo: String(pr.repo), number: pr.number, run });
      if (mergedAt !== null) return Date.parse(mergedAt);
    } catch {
      continue;
    }
  }
  return null;
};

function stillOpenAndBehind(repo: string, number: number, run: Run): boolean {
  try {
    return (rows().openPullBehindBy({ repo, number, run }) ?? 0) > 0;
  } catch {
    return false; // could not tell: not touched
  }
}

/** Open PRs red on the incident's check since BEFORE the fix merged, whose failure matches the incident's: the ones nobody noted. */
function lateVictims(row: IncidentRow, { open, mergedAt, run }: { open: readonly RedPr[]; mergedAt: number; run: Run }): string[] {
  const check = CHECK_LINE.exec(row.body)?.[1]?.trim();
  const wanted = /^First error line: (.*)$/m.exec(row.body)?.[1]?.trim();
  if (check === undefined || wanted === undefined) return [];
  return open.filter((pr) => pr.checks.some((c) => c.name === check && Date.parse(String(c.completedAt)) < mergedAt && readSignature(c, run)?.line === wanted)).map(notedAs);
}

function stamp(row: IncidentRow, { late, failed, run, log, nowMs }: { late: string[]; failed: string[]; run: Run; log: (line: string) => void; nowMs: number }): void {
  const prior = listOf(row.body, FAILED_LINE);
  const lines = [
    ...(late.length > 0 ? [`Late-victims: ${late.join(", ")}`] : []),
    ...(failed.length + prior.length > 0 ? [`Refresh-failed: ${[...new Set([...prior, ...failed])].join(", ")}`] : []),
    `Refreshed-at: ${new Date(nowMs).toISOString()}`,
  ];
  try {
    rows().setRowBody({ number: row.number, body: `${row.body}\n\n${lines.join("\n")}`, run });
  } catch (error) {
    log(`ci-shared-failure: refreshed but could not stamp #${row.number} (${String((error as Error).message).split("\n")[0]}); the next tick tries again\n`);
  }
}

const refusedOf = (incidents: readonly IncidentRow[]): string[] => incidents.flatMap((row) => listOf(String(row.body), FAILED_LINE));

/**
 * THE TICK'S ONE CALL. Refresh what a merged fix owes, hold what a shared failure owes nobody, file or join the incident, and return what remains. Never throws: a tick that cannot
 * do this sends the orders as it always did. A group is held only while {@link standingOf} says so AND its incident row is on record: a row that cannot be filed releases it.
 */
export function sharedFailureTick<O extends OrderLike>(
  orders: readonly O[], deps: { prs: readonly RedPr[]; run: Run; log?: (line: string) => void; nowMs?: number },
): { orders: O[]; held: HeldOrder[]; released: ReleasedOrder[]; refreshed: string[] } {
  const log = deps.log ?? ((line: string) => void process.stderr.write(line));
  const nowMs = deps.nowMs ?? Date.now();
  try {
    const { refreshed, refused } = refreshFixed({ run: deps.run, log, nowMs, open: deps.prs });
    for (const ref of refreshed) log(`ci-shared-failure: updated ${ref} from main (its incident's fix merged) -- no worker woken\n`);
    const incidents = { open: readRows(deps.run, "open"), closed: readRows(deps.run, "closed"), nowMs };
    const standing = (group: SharedGroup): Standing => {
      const said = standingOf(group, incidents);
      return said.hold && recordIncident(group, { run: deps.run, log }) === null ? { hold: false, why: "unrecorded" } : said;
    };
    const waiting = new Set(deps.prs.filter((pr) => refreshed.includes(notedAs(pr))).map((pr) => pr.ref)); // its CI is running again: nobody is woken for the old red
    const pending = orders.filter((o) => !(o.cause === "pr-checks-failing" && waiting.has(String(o.subject))));
    const out = holdSharedFailures(pending, { prs: deps.prs, run: deps.run, refused: [...refused, ...refusedOf([...incidents.open, ...incidents.closed])], standing });
    if (out.held.length > 0) log(`ci-shared-failure: holding ${out.held.length} red order(s) of a shared failure:${out.held.map((h) => ` ${h.subject}`).join("")}\n`);
    if (out.released.length > 0) log(`ci-shared-failure: released ${out.released.length} red order(s), their hold is over:${out.released.map((r) => ` ${r.subject} (${r.why})`).join("")}\n`);
    for (const key of new Set(out.held.map((h) => h.key))) { // #1557: one line per held incident that nobody has claimed past the bound; the holds themselves wait for it to close
      const row = incidents.open.find((r) => r.body.includes(markerOf(key)));
      const isOldUnclaimedRow = row !== undefined && !(row.labels ?? []).includes(CLAIM_LABEL) && nowMs - Date.parse(String(row.createdAt)) >= HOLD_MAX_MS;
      if (isOldUnclaimedRow) {
        log(`ci-shared-failure: incident #${row.number} has been open ${HOLD_MAX_MS / 60_000} minutes with no claim; its held pull requests wait for it to close, and no worker is woken\n`);
      }
    }
    return { orders: out.orders, held: out.held, released: out.released, refreshed };
  } catch (error) {
    log(`ci-shared-failure: could not run (${String((error as Error).message).split("\n")[0]}); the orders go out as they were\n`);
    return { orders: [...orders], held: [], released: [], refreshed: [] };
  }
}
