// @ts-check
// module: the code host contract's suite (A11-158; A11-167 adds `readMergedFindings`; A11-160 adds the checks, the review claim and the verdict door) -- `runCodeHostConformance(host, probe)` is the only definition of "a code host"
//
// EVERY READ ANSWERS `null` FOR "COULD NOT ASK", NEVER FOR "THERE IS NONE": that is the property a caller relies on, so the suite asks about a pull request the host
// does not have and requires `null`. The caller seeds what the probe names: an open pull request the host holds (`pull`) with the repository it is in
// (`repository`), a pull request address it holds nothing for (`missing`), and the login the host acts as (`self`). A code host is synchronous, as every reader of it is.
import type { ChangeRef, CodeHost, WrapperInputs } from "../contracts/code-host.ts";
import { type Conditional, type ConformanceResult, expect, hasFunctions, isObject, isString, runChecks } from "./suite.ts";

/**
 * What the caller has seeded: an open pull request, its repository, one the host has none of, the account the host acts as, and optionally a change for the port's reads, the inputs a wrapper is asked about
 * (a host that installs no wrapper is not asked) and a merged pull request that has findings (`merged`, A11-167).
 */
export type CodeHostProbe = Readonly<{
  pull: string; repository: string; missing: string; self: string; change?: ChangeRef; wrapper?: WrapperInputs; merged?: string;
  /** A failing check's address whose log the host holds (`log`), and the text that log has to contain. */
  check?: Readonly<{ detailsUrl: string; log: string }>;
  /** A head a claim may be written on: the repository, the head, and the environment the claim is written with. Writing one is not undone, so a caller seeds a head it can discard. */
  claim?: Readonly<{ repository: string; head: string; environment: Readonly<Record<string, string>> }>;
}>;
type Subject = Readonly<{ host: CodeHost; probe: CodeHostProbe }>;

const OPERATIONS = ["readOwnLogin", "readPullFeedback", "readReplies", "readReviewState", "readPullState", "openPullUrlsOf", "sweepRetargets", "readCheckLog", "rerunFailedChecks", "readReviewClaims", "writeReviewClaim", "readChange", "requestReview", "armMerge", "subscribe"] as const;
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
  "readReplies answers a list of replies, and null for a pull request it cannot read": ({ host, probe }) => {
    const replies = host.readReplies(probe.pull, { since: 0, authors: [probe.self] });
    expect(Array.isArray(replies) && replies.every((reply) => isString(reply.author) && isString(reply.url) && isString(reply.text) && Number.isFinite(reply.at)), `readReplies(${probe.pull}) must be a list of { author, at, url, text }`);
    expect(replies.every((reply) => reply.author === probe.self), "readReplies must return only the accounts it is asked for");
    expect(host.readReplies(probe.pull, { since: 0, authors: [] })?.length === 0, "readReplies of no accounts must be an empty list, never a reply of a stranger's");
    expect(host.readReplies(probe.missing, { since: 0, authors: [probe.self] }) === null, "readReplies must answer null for what it cannot read: null is never 'no replies'");
  },
  "readPullState names the state or answers null": ({ host, probe }) => {
    expect(PULL_STATES.includes(String(host.readPullState(probe.pull))), `readPullState(${probe.pull}) must be OPEN, MERGED or CLOSED`);
    expect(host.readPullState(probe.missing) === null, "readPullState must answer null for a pull request it cannot read");
  },
  "readReviewState reads the head, the reviews and whether the checks settled": ({ host, probe }) => {
    const state = host.readReviewState(probe.pull);
    expect(isObject(state) && isString(state.head) && Array.isArray(state.reviews) && typeof state.settled === "boolean", `readReviewState(${probe.pull}) must read { head, reviews, settled }`);
    expect(!isObject(state) || state.unrequiredRed === undefined || (Array.isArray(state.unrequiredRed) && state.unrequiredRed.every(isString)), `readReviewState(${probe.pull}) must name unrequiredRed, when it has any, as a list of check names`);
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
  "readCheckLog answers null for an address that names no job": ({ host }) => {
    expect(host.readCheckLog("https://example.invalid/checks/not-a-job") === null, "readCheckLog must answer null for an address that names no job: null is never 'the log is empty'");
  },
  "rerunFailedChecks of no checks reruns nothing and says so": ({ host }) => {
    expect(host.rerunFailedChecks([]) === null, "rerunFailedChecks of no addresses must answer null: there is nothing to refuse");
    expect(host.rerunFailedChecks(["https://example.invalid/checks/not-a-job"]) === null, "rerunFailedChecks must leave out an address that names no run");
  },
  "readReviewClaims answers the entries of a head, or why it could not": ({ host, probe }) => {
    const read = host.readReviewClaims(probe.repository, "0".repeat(40));
    const entries = "entries" in read ? read.entries : undefined;
    expect(isObject(read) && (Array.isArray(entries) !== isString("unreadable" in read ? read.unreadable : undefined)), "readReviewClaims must answer { entries } or { unreadable }, and never both or neither");
    expect(entries === undefined || entries.every((entry) => Number.isFinite(entry.id) && isString(entry.description) && Number.isFinite(entry.created)), "each claim entry must be { id, description, created }");
    expect(!("unreadable" in read) || read.unreadable !== "", "the reason a claim could not be read must say something");
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

const withWrapper = (reason: string, run: (subject: Subject & { inputs: WrapperInputs }) => unknown): Conditional<Subject> => ({
  applies: ({ host, probe }) => host.wrapper !== undefined && probe.wrapper !== undefined, reason: `the code host has no wrapper or the probe names no inputs for one, so ${reason}`, run: (subject) => run({ ...subject, inputs: subject.probe.wrapper! }),
});

const withCheck = (reason: string, run: (subject: Subject & { check: NonNullable<CodeHostProbe["check"]> }) => unknown): Conditional<Subject> => ({
  applies: ({ probe }) => probe.check !== undefined, reason: `the probe names no check, so ${reason}`, run: (subject) => run({ ...subject, check: subject.probe.check! }),
});

const withClaim = (reason: string, run: (subject: Subject & { claim: NonNullable<CodeHostProbe["claim"]> }) => unknown): Conditional<Subject> => ({
  applies: ({ probe }) => probe.claim !== undefined, reason: `the probe names no head to claim, so ${reason}`, run: (subject) => run({ ...subject, claim: subject.probe.claim! }),
});

const CONDITIONAL: Readonly<Record<string, Conditional<Subject>>> = {
  "readCheckLog reads the log behind a failing check": withCheck("no check's log is read", ({ host, check }) => {
    const log = host.readCheckLog(check.detailsUrl);
    expect(isString(log) && log.includes(check.log), `readCheckLog(${check.detailsUrl}) must read the log the host holds`);
  }),
  "a claim written on a head is read back from it": withClaim("no claim is written", ({ host, claim }) => {
    const description = `claimed by conformance at ${new Date(0).toISOString()}, lease 60 min`;
    const before = host.readReviewClaims(claim.repository, claim.head);
    expect("entries" in before, `readReviewClaims(${claim.repository}, ${claim.head}) must read the head the probe names`);
    expect(host.writeReviewClaim({ repository: claim.repository, head: claim.head, description, environment: claim.environment }) === null, "writeReviewClaim must answer null once the claim is written");
    const after = host.readReviewClaims(claim.repository, claim.head);
    expect("entries" in after && after.entries.length === before.entries.length + 1 && after.entries.some((entry) => entry.description === description), "the claim written must be read back among the head's entries");
  }),
  "the verdict door is a file the plugin ships, with the program that installs it": {
    applies: ({ host }) => host.verdictDoor !== undefined,
    reason: "the code host ships no verdict door, which is optional (contract 1.5)",
    run: ({ host }) => {
      const door = host.verdictDoor!;
      expect(isString(door.source) && door.source.startsWith("/") && isString(door.installer) && door.installer.startsWith("/"), "verdictDoor must be { source, installer }, each an absolute path");
    },
  },
  "readMergedFindings reads what a merged pull request found, and answers null for one it cannot read or that has not merged": {
    applies: ({ host }) => typeof host.readMergedFindings === "function",
    reason: "the code host has no readMergedFindings, which is optional (contract 1.4)",
    run: ({ host, probe }) => {
      expect(host.readMergedFindings!(probe.missing) === null, "readMergedFindings must answer null for what it cannot read: null is never 'it found nothing'");
      expect(host.readMergedFindings!(probe.pull) === null, "readMergedFindings must answer null for a pull request that has not merged, whose findings are not final");
      if (probe.merged === undefined) return;
      const found = host.readMergedFindings!(probe.merged);
      expect(isObject(found) && isString(found.title) && Number.isInteger(found.number) && isString(found.body) && Array.isArray(found.sections), `readMergedFindings(${probe.merged}) must read { title, number, body, sections }`);
      expect(found.sections.every((section) => isString(section.file) && isString(section.heading) && isString(section.text)), "each section must be { file, heading, text }");
    },
  },
  "readChange reads a change, and answers null for one it cannot": withChange("the port's reads are not asked", ({ host, change }) => {
    const facts = host.readChange(change);
    expect(isObject(facts) && isString(facts.head) && Array.isArray(facts.checks) && Array.isArray(facts.reviews) && isObject(facts.merge), "readChange must read { ref, head, checks, reviews, merge }");
    expect(host.readChange({ host: change.host, id: "no-such-change" }) === null, "readChange must answer null for a change it cannot read");
  }),
  "armMerge arms the merge and says it is armed": withChange("the merge is not armed", ({ host, change }) => {
    expect(host.armMerge(change) === true, "armMerge must answer true once the merge is armed");
  }),
  "the wrapper is an owned file its own text agrees with": withWrapper("the wrapper is not asked", ({ host, inputs }) => {
    const wrapper = host.wrapper!;
    expect(hasFunctions(wrapper, ["file", "appRoles", "refusal", "divergence", "identityStale", "mintFailure"]), "a wrapper has file, appRoles, refusal, divergence, identityStale and mintFailure functions");
    const { target, mode, expected } = wrapper.file(inputs);
    expect(isString(target) && target !== "" && Number.isInteger(mode) && (expected === null || (isString(expected) && expected !== "")), "wrapper.file() must be { target, mode, expected }: expected is the text, or null when it cannot be read, never ''");
    expect(wrapper.divergence(inputs, { target, installed: expected }) === null, "the wrapper is not diverged from its own text");
    expect(isString(wrapper.divergence(inputs, { target, installed: null })), "wrapper.divergence() must say there is no wrapper where nothing is installed");
    expect(Array.isArray(wrapper.appRoles(inputs)) && wrapper.appRoles(inputs).every(isString), "wrapper.appRoles() must be a list of roles");
  }),
  "the wrapper keeps its own text, and writes it": withWrapper("the wrapper is not asked", ({ host, inputs }) => {
    const wrapper = host.wrapper!;
    const { target, expected } = wrapper.file(inputs);
    expect(expected !== null, "the probe's wrapper must have a text to write");
    expect(wrapper.identityStale(inputs, expected!) === false, "the wrapper's own text is not stale");
    expect(wrapper.refusal({ inputs, target, text: expected!, installed: expected, allowNoApps: false, under: false, realBin: "/nonexistent/real-bin" }) === null, "the wrapper must not refuse to write its own text over itself");
  }),
  "the wrapper answers whether each declared role mints": withWrapper("the wrapper is not asked", ({ host, inputs }) => {
    const wrapper = host.wrapper!;
    for (const role of wrapper.appRoles(inputs)) {
      const failure = wrapper.mintFailure(inputs, role);
      expect(failure === null || (isString(failure) && failure !== ""), `wrapper.mintFailure(${role}) must be the reason it cannot mint, or null`);
    }
    expect(wrapper.mintFailure(inputs, "no-such-role") === null, "a role with no App has nothing to fail to mint");
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
