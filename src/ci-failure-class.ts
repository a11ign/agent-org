// #4632: A RED PULL REQUEST'S FAILURE IS CLASSIFIED, AND ROUTED BY CLASS. A `pr-checks-failing` order says a check is red and leaves every judgment to its reader: whose defect, whether to
// rerun, whether another repository moved. This module answers those four from the failing test's error lines plus facts the CODE computed, and returns the class and its route as DATA.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). It goes through `decide` (`decision-provider.ts`) as the use `ci-failure-class`, so there is no client, key read or switch here. With no
// provider, no key, the use switched off, a refusal, a timeout or a confidence under the floor the answer is {@link fallbackClass}, and nothing breaks or nags.
//
// THE PROVIDER ONLY CLASSIFIES. It never reruns, labels or comments: the gate does that from {@link CiFailureDecision.route}, in its own code. The FACTS (does the same test fail on `main`,
// on other open PRs, does it read outside its repository, is the text a rate limit) are computed by the caller and passed in as state; they are never asked of the provider.
//
// THE CALL SITE (`work-gate.ts`, where the `pr-checks-failing` order is built) is its own row: until it lands this classifies nothing in production.
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
