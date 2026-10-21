// @ts-check
// module: the code host contract's suite (A11-158) -- `runCodeHostConformance(host, probe)` is the only definition of "a code host"
//
// EVERY READ ANSWERS `null` FOR "COULD NOT ASK", NEVER FOR "THERE IS NONE": that is the property a caller relies on, so the suite asks about a pull request the host
// does not have and requires `null`. The caller seeds what the probe names: an open pull request the host holds (`pull`) with the repository it is in
// (`repository`), a pull request address it holds nothing for (`missing`), and the login the host acts as (`self`). A code host is synchronous, as every reader of it is.
import type { CodeHost, ChangeRef } from "../contracts/code-host.ts";
import { type Conditional, type ConformanceResult, expect, hasFunctions, isObject, isString, runChecks } from "./suite.ts";

/** What the caller has seeded: an open pull request, its repository, one the host has none of, the account the host acts as, and optionally a change for the port's reads. */
export type CodeHostProbe = Readonly<{ pull: string; repository: string; missing: string; self: string; change?: ChangeRef }>;
type Subject = Readonly<{ host: CodeHost; probe: CodeHostProbe }>;

const OPERATIONS = ["readOwnLogin", "readPullFeedback", "readReviewState", "readPullState", "openPullUrlsOf", "sweepRetargets", "readChange", "requestReview", "armMerge", "subscribe"] as const;
const PULL_STATES = ["OPEN", "MERGED", "CLOSED"];

const ALWAYS: Readonly<Record<string, (subject: Subject) => unknown>> = {
  "readOwnLogin names the account or answers null": ({ host }) => {
    const login = host.readOwnLogin();
    expect(login === null || (isString(login) && login !== ""), "readOwnLogin() must be a login, or null when it cannot be read");
  },
  "readPullFeedback reads a pull request": ({ host, probe }) => {
    const feedback = host.readPullFeedback(probe.pull, probe.self);
    expect(isObject(feedback), `readPullFeedback(${probe.pull}) must read the pull request the host holds`);
    expect(["open", "merged", "closed"].includes(String(feedback.state)), "feedback.state must be open, merged or closed");
    expect(Array.isArray(feedback.failing) && Array.isArray(feedback.failures) && Array.isArray(feedback.authors) && Array.isArray(feedback.files), "feedback.failing, failures, authors and files must be lists");
    expect(typeof feedback.conflicting === "boolean" && typeof feedback.filesComplete === "boolean", "feedback.conflicting and filesComplete must be true or false");
    expect(typeof feedback.mergeable === "boolean" && typeof feedback.approvedAtHead === "boolean" && (feedback.head === null || isString(feedback.head)), "feedback.mergeable and approvedAtHead must be true or false, and head a commit or null");
  },
  "readPullFeedback answers null for a pull request it cannot read": ({ host, probe }) => {
    expect(host.readPullFeedback(probe.missing, probe.self) === null, "readPullFeedback must answer null for what it cannot read: null is never 'no feedback'");
  },
  "readPullState names the state or answers null": ({ host, probe }) => {
    expect(PULL_STATES.includes(String(host.readPullState(probe.pull))), `readPullState(${probe.pull}) must be OPEN, MERGED or CLOSED`);
    expect(host.readPullState(probe.missing) === null, "readPullState must answer null for a pull request it cannot read");
  },
  "readReviewState reads the head, the reviews and whether the checks settled": ({ host, probe }) => {
    const state = host.readReviewState(probe.pull);
    expect(isObject(state) && isString(state.head) && Array.isArray(state.reviews) && typeof state.settled === "boolean", `readReviewState(${probe.pull}) must read { head, reviews, settled }`);
    expect(host.readReviewState(probe.missing) === null, "readReviewState must answer null for a pull request it cannot read");
  },
  "openPullUrlsOf lists a repository's open pull requests": ({ host, probe }) => {
    const urls = host.openPullUrlsOf(probe.repository);
    expect(Array.isArray(urls) && urls.every(isString), `openPullUrlsOf(${probe.repository}) must be a list of addresses`);
    expect(urls.includes(probe.pull), `openPullUrlsOf(${probe.repository}) must list the open pull request ${probe.pull}`);
  },
  "sweepRetargets keeps the note of a pull request it cannot read": ({ host, probe }) => {
    const note = "Needs retarget: kept from the last sweep";
    const notes = host.sweepRetargets({ urls: [probe.missing], previous: { [probe.missing]: note }, stacked: new Set(["feature/base"]), defaults: new Map(), log: () => undefined });
    expect(notes[probe.missing] === note, "sweepRetargets must keep the note a pull request had when it cannot be read, and ask again on the next sweep");
  },
  "sweepRetargets with no pull requests has no notes": ({ host }) => {
    const notes = host.sweepRetargets({ urls: [], previous: {}, stacked: new Set(), defaults: new Map(), log: () => undefined });
    expect(isObject(notes) && Object.keys(notes).length === 0, "sweepRetargets of no pull requests must have no notes");
  },
  "subscribe returns the function that cancels it": ({ host }) => {
    let received = 0;
    const cancel = host.subscribe({}, () => { received += 1; });
    expect(typeof cancel === "function", "subscribe() must return the function that cancels it");
    cancel();
    expect(received === 0, "a subscription must not be called with an event that never happened");
  },
};

const withChange = (reason: string, run: (subject: Subject & { change: ChangeRef }) => unknown): Conditional<Subject> => ({
  applies: ({ probe }) => probe.change !== undefined, reason: `the probe names no change, so ${reason}`, run: (subject) => run({ ...subject, change: subject.probe.change! }),
});

const CONDITIONAL: Readonly<Record<string, Conditional<Subject>>> = {
  "readChange reads a change, and answers null for one it cannot": withChange("the port's reads are not asked", ({ host, change }) => {
    const facts = host.readChange(change);
    expect(isObject(facts) && isString(facts.head) && Array.isArray(facts.checks) && Array.isArray(facts.reviews) && isObject(facts.merge), "readChange must read { ref, head, checks, reviews, merge }");
    expect(host.readChange({ host: change.host, id: "no-such-change" }) === null, "readChange must answer null for a change it cannot read");
  }),
  "armMerge arms the merge and says it is armed": withChange("the merge is not armed", ({ host, change }) => {
    expect(host.armMerge(change) === true, "armMerge must answer true once the merge is armed");
  }),
};

/**
 * Runs every check against `host`, so one run reports EVERY way a code host is wrong.
 * @throws ContractError listing each failed check
 */
export function runCodeHostConformance(host: CodeHost, probe: CodeHostProbe): Promise<ConformanceResult> {
  return runChecks("codeHost", { host, probe }, {
    shape: ({ host: candidate }) => expect(hasFunctions(candidate, OPERATIONS), `a code host is an object with ${OPERATIONS.join(", ")} functions`),
    always: ALWAYS,
    conditional: CONDITIONAL,
  });
}
