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
import { decide, MAX_STATE_BYTES, type DecisionDeps, type Question } from "./decision-provider.ts";

export const CI_FAILURE_CLASSES = Object.freeze(["own-defect", "flaky", "another-repository-changed", "infrastructure"] as const);
export type CiFailureClass = (typeof CI_FAILURE_CLASSES)[number];
export const CI_FAILURE_ROUTES = Object.freeze(["owner", "rerun-once", "cross-repo-incident", "rerun-after-reset"] as const);
export type CiFailureRoute = (typeof CI_FAILURE_ROUTES)[number];

/** At most this many error lines are sent, so the state stays a few fields and never a log. */
export const MAX_ERROR_LINES = 40;
const MAX_LINE_CHARS = 160;
/** Room left under the decision seam's own state limit for the fields that are not error lines. */
const FACTS_HEADROOM_BYTES = 512;
const QUESTION = "class";
const INSTRUCTIONS = "A pull request's CI check is red. From the failing test's error lines and the facts, which class is the failure?";
// eslint-disable-next-line no-control-regex -- the escape character is what an ANSI colour code starts with
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** What is known about one red check. The four booleans are computed in code; `rerunAlready` is whether this run was already rerun once. */
export type CiFailureFacts = {
  /** The same test is red on `main` at the same time. */
  redOnMain: boolean;
  /** The same test is red on other open pull requests at the same time. */
  redOnOtherPrs: boolean;
  /** The test reads outside its repository (another repository's checkout, the network, the host). */
  readsOutsideRepository: boolean;
  /** The error text is a rate limit or a runner that was lost. */
  rateLimitOrRunnerLost: boolean;
  rerunAlready: boolean;
};
export type CiFailure = CiFailureFacts & { errorLines: readonly string[] };
export type CiFailureDecision = {
  klass: CiFailureClass;
  route: CiFailureRoute;
  /** `jev` when the provider chose the class, else `none`. */
  via: "jev" | "none";
  /** The provider's answer was replaced by the rule (or never asked); `reason` says why. */
  fellBack: boolean;
  reason?: string;
  confidence?: number;
};

const CRITERIA: Readonly<Record<CiFailureClass, string>> = Object.freeze({
  "own-defect": "the failure comes from this pull request's own change: the error names code or a test it touched and nothing else explains it.",
  flaky: "the test passes and fails without a change: a timing, ordering or race error, red on this pull request alone and not on main.",
  "another-repository-changed": "the test reads another repository or a pinned dependency, and that repository changed: the same test is red on main or on other pull requests.",
  infrastructure: "the runner, the network or a rate limit failed, whatever the code did.",
});

const ROUTES: Readonly<Record<CiFailureClass, CiFailureRoute>> = Object.freeze({
  "own-defect": "owner",
  flaky: "rerun-once",
  "another-repository-changed": "cross-repo-incident",
  infrastructure: "rerun-after-reset",
});

/**
 * THE RULE WITH NO PROVIDER. A rate-limit or runner-lost text is infrastructure FIRST, because a runner lost on `main` too is still not a repository that changed; the same test red on
 * `main` is another repository's change; everything else is the pull request's own defect, which is today's order unchanged.
 */
export function fallbackClass(facts: Pick<CiFailureFacts, "redOnMain" | "rateLimitOrRunnerLost">): CiFailureClass {
  if (facts.rateLimitOrRunnerLost) return "infrastructure";
  return facts.redOnMain ? "another-repository-changed" : "own-defect";
}

/** The class's route. A flaky failure is rerun ONCE: one already rerun goes to its owner, never a second rerun. */
export function routeFor(klass: CiFailureClass, rerunAlready: boolean): CiFailureRoute {
  return klass === "flaky" && rerunAlready ? ROUTES["own-defect"] : ROUTES[klass];
}

/** The first non-blank lines with colour codes removed and each line cut, kept under {@link MAX_ERROR_LINES} and the bytes the seam allows beside the facts. */
export function trimErrorLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let bytes = FACTS_HEADROOM_BYTES;
  for (const raw of lines) {
    const line = raw.replace(ANSI, "").trim().slice(0, MAX_LINE_CHARS);
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
});

const isClass = (value: unknown): value is CiFailureClass => typeof value === "string" && (CI_FAILURE_CLASSES as readonly string[]).includes(value);

/**
 * CLASSIFY ONE RED CHECK AND NAME WHERE IT GOES. Never throws and always returns a class: the provider's when it answered at or over the floor, {@link fallbackClass} otherwise.
 * `deps` is `decide`'s (the host, the switches, the log); pass `id` (the causeKey) so `recordOutcome` can later say whether the class was right.
 */
export async function classifyCiFailure(failure: CiFailure, deps: DecisionDeps): Promise<CiFailureDecision> {
  const fallback = fallbackClass(failure);
  const question: Question = { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA, fallback };
  const state = stateOf(failure, trimErrorLines(failure.errorLines));
  const decision = await decide("ci-failure-class", state, { [QUESTION]: question }, deps);
  const answer = decision.answers[QUESTION];
  // The seam checks a choice against the criteria, so this is the belt to its braces: a value that is no class is the rule's.
  const klass = isClass(answer.value) ? answer.value : fallback;
  return {
    klass,
    route: routeFor(klass, failure.rerunAlready),
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

/** `gh`, as an injected seam: the arguments after `gh`, the stdout back. */
export type Gh = (args: string[]) => string;
/** The pull request a red order is about: `repo` is `owner/name`, and `head8` is the head the order's cause key carries. */
export type RedPullRequest = { repo: string; number: number; head8: string };

/** A run this recent counts as "at the same time". A red `main` from last week is a different failure. */
export const SAME_TIME_MS = 6 * 60 * 60 * 1000;
const RUNS_LISTED = 50;
const MAIN_RUNS_LISTED = 10;
const LOG_LINES_KEPT = 200;
/** A line of a job log worth quoting: an error, a failed assertion or test. The log's own noise (the checkout, the cache, `##[group]`) is not. */
// No word boundaries: `AssertionError` and `TypeError` are the lines that matter, and a boundary after `error` would skip both.
const ERROR_LINE = /error|errno|fail|assert|not ok|exception|timed? ?out|rate limit|cancell?ed|\u2716|\u2717/i;
const RATE_LIMIT_OR_RUNNER_LOST = /rate limit|runner has received a shutdown signal|lost communication with the server|hosted runner .* lost|runner .* (?:was|has been) (?:lost|terminated)/i;
const READS_OUTSIDE = /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED)\b|getaddrinfo|could not resolve host|unable to access '?https?:/i;
const RED_CONCLUSIONS = new Set(["failure", "timed_out"]);
const RUN_AND_JOB = /\/actions\/runs\/(\d+)\/job\/(\d+)/;

type CheckRun = { name?: string; conclusion?: string | null; details_url?: string | null };
type WorkflowRun = { name?: string; conclusion?: string | null; head_branch?: string; head_sha?: string; updated_at?: string; run_attempt?: number };

const json = (gh: Gh, path: string): any => JSON.parse(gh(["api", path]));
const recent = (run: WorkflowRun, now: number): boolean => now - Date.parse(String(run.updated_at)) <= SAME_TIME_MS;

/** Is the newest run of `workflow` on `main` red, and recent? The newest only: a green run since then is a repair. */
function redOnMainNow(runs: readonly WorkflowRun[], workflow: string, now: number): boolean {
  const newest = runs.find((run) => run.name === workflow);
  return newest !== undefined && newest.conclusion === "failure" && recent(newest, now);
}

/** Does another branch's recent run of `workflow` fail too? Compared by BRANCH, because a fork's run carries no pull request number. */
function redOnOtherPrsNow(runs: readonly WorkflowRun[], { workflow, branch, now }: { workflow: string; branch: string; now: number }): boolean {
  return runs.some((run) => run.name === workflow && run.conclusion === "failure" && run.head_branch !== branch && run.head_branch !== "main" && recent(run, now));
}

/**
 * THE FACTS OF ONE RED PULL REQUEST, or `null` when they could not be read or there is nothing red at the head the order names (the head moved, or the red check is not an Actions job).
 * The first failing check is the one classified: a pull request with several red checks is told about the first, and the order's own text still lists them all.
 * @param now an injected clock, so "at the same time" is testable
 */
export function readCiFailure({ repo, number, head8 }: RedPullRequest, gh: Gh, now: number = Date.now()): CiFailure | null {
  const pull = json(gh, `repos/${repo}/pulls/${number}`);
  const sha = String(pull?.head?.sha ?? "");
  if (!sha.startsWith(head8)) return null;
  const checks: CheckRun[] = json(gh, `repos/${repo}/commits/${sha}/check-runs?per_page=100`)?.check_runs ?? [];
  const red = checks.find((check) => RED_CONCLUSIONS.has(String(check.conclusion)));
  const ids = RUN_AND_JOB.exec(String(red?.details_url ?? ""));
  if (red === undefined || ids === null) return null;
  const run: WorkflowRun = json(gh, `repos/${repo}/actions/runs/${ids[1]}`);
  const workflow = String(run.name ?? "");
  const log = gh(["api", `repos/${repo}/actions/jobs/${ids[2]}/logs`]);
  const errorLines = log.split("\n").filter((line) => ERROR_LINE.test(line)).slice(-LOG_LINES_KEPT);
  const onMain: WorkflowRun[] = json(gh, `repos/${repo}/actions/runs?branch=main&per_page=${MAIN_RUNS_LISTED}`)?.workflow_runs ?? [];
  const failing: WorkflowRun[] = json(gh, `repos/${repo}/actions/runs?status=failure&event=pull_request&per_page=${RUNS_LISTED}`)?.workflow_runs ?? [];
  return {
    errorLines,
    redOnMain: redOnMainNow(onMain, workflow, now),
    redOnOtherPrs: redOnOtherPrsNow(failing, { workflow, branch: String(pull?.head?.ref ?? ""), now }),
    readsOutsideRepository: errorLines.some((line) => READS_OUTSIDE.test(line)),
    rateLimitOrRunnerLost: RATE_LIMIT_OR_RUNNER_LOST.test(log),
    rerunAlready: Number(run.run_attempt ?? 1) > 1,
  };
}

const ROUTE_WORDS: Readonly<Record<CiFailureRoute, string>> = Object.freeze({
  owner: "The failure is this pull request's own: fixing it is yours.",
  "rerun-once": "A flaky failure: rerun the failed job ONCE (`gh run rerun <run id> --failed`); red again, it is your defect.",
  "cross-repo-incident": "Another repository or a pinned dependency changed: this is not this pull request's defect, so do not fix it here; file or join the cross-repository incident for the cause.",
  "rerun-after-reset": "The runner or a rate limit failed, not the code: change nothing; rerun the failed job after the limit resets.",
});

/** What the order's text gains when the PROVIDER chose the class: the line, and what the route asks of its reader. A rule's class changes nothing, which is today's order. */
export function classNote(decision: CiFailureDecision): string {
  return `${classLine(decision)}. ${ROUTE_WORDS[decision.route]}`;
}
