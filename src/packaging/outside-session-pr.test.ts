// no-token: gh -- pure: `decide` over in-memory pull requests and the identities passed in, and `machineryValues` over in-memory facts; nothing here reaches `gh`, `git` or the network
/**
 * agent-org#1667: A SAME-REPOSITORY PULL REQUEST WITH A `session:` LABEL THAT `reviewTrustOf` CLASSES OUTSIDE IS A SESSION'S OWN, AND THE GATE SAYS SO.
 *
 * With `prs.ownerRouting` ON, `withholdOutsideFollowUps` drops every follow-up of an OUTSIDE pull request but its review, so a not-convinced verdict
 * on a session's own pull request (opened under an account the host does not declare) wakes nobody. With `reviews.outsideSessionPr` ON too, the one
 * verdict whose only finding is that no CI Acceptance run is available is kept and addressed to the reader (`ownerOfPr`), and the signal
 * `session-pr-classed-outside` counts each such pull request classed OUTSIDE for `SESSION_PR_OUTSIDE_MINUTES`. With the flag OFF, both are as they were.
 *
 * THE ORDER PATH IS `decide`, as in `pr-owner-routing.test.ts`: the withholding is its last step. Every wake is run against the flag-off control, where
 * the same verdict is withheld, so an empty result with the flag on is the filter's and not an empty fixture's.
 *
 * MUTATIONS (run by hand, recorded on the row): (a) keeping every verdict, not only the no-run one, turns the mixed-findings test red; (b) classing a
 * declared-login pull request OUTSIDE turns the declared-login control red; (c) the signal reading 9 minutes as 10 turns the clock test red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../work-gate/tick/tick-decisions-and-flags.ts";
import { outsideSessionPrFlagOn } from "../work-gate/tick/tick-decisions-and-flags.ts";
import { SESSION_PR_OUTSIDE_FLAG, classedOutsideSessionPrs, onlyNoAcceptanceRun, sessionPrOutsideNow, sessionPrVerdictWakes } from "../work-gate/outside-session-pr.ts";
import { FLAG_REGISTRY } from "../machinery-flag.ts";
import { MACHINERY_SIGNALS, SESSION_PR_OUTSIDE_MINUTES, sessionPrOutsideReading, sessionPrOutsideReadings } from "../org-health/hold-and-rerun-readings.ts";
import { STANDARD_MACHINERY_SIGNALS, emptyCanaryState } from "../org-health/fleet-build-readings.ts";
import { machineryValues, withMachineryFlag } from "../org-health.ts";
import { OUTSIDE, INSIDE, reviewTrustOf, type DeclaredIdentities } from "../review-trust.ts";
import { CHAIRMAN_LOGINS } from "../work-gate/vocabulary.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";

type Order = { session: string; cause: string; subject?: string; causeKey: string; };
type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-17T09:00:00Z");
const HEAD = "ab698778cafe0000";
const REQUIRED = ["gate"];
/** The identities the org declares, passed in so the test does not read the host. `worker-account-1667` is NOT among them. */
const IDENTITIES: DeclaredIdentities = { exact: [...CHAIRMAN_LOGINS, "a11ign-ai-workers"], pattern: [] };
const SESSION = "worker-agent-org-1667";

const SETTLED = (name: string, conclusion = "SUCCESS") => ({
  name, status: "COMPLETED", conclusion, startedAt: "2026-10-17T07:00:00Z", completedAt: "2026-10-17T07:05:00Z",
});
const GREEN = [SETTLED("lint"), SETTLED("typecheck"), SETTLED("test"), SETTLED("gate")];

/** A same-repository pull request whose author the host does NOT declare: the session's own work, classed OUTSIDE by `reviewTrustOf`. */
const UNDECLARED_AUTHOR = { isCrossRepository: false, author: { login: "worker-account-1667" } };
/** A same-repository pull request a declared identity opened: INSIDE, the control that a declared login is never classed OUTSIDE. */
const DECLARED_AUTHOR = { isCrossRepository: false, author: { login: "a11ign-ai-workers" } };
/** A fork: its head is not in the repository. */
const FORK_AUTHOR = { isCrossRepository: true, author: { login: "some-stranger" } };

const SESSION_LABEL = { name: `${SESSION_PREFIX}${SESSION}` };

const prOf = (number: number, over: Pr = {}): Pr => ({
  number, repo: "a11ign/agent-org", repoKey: "agent-org", headRefOid: HEAD, headRefName: `contrib-branch-${number}`, isDraft: false,
  statusCheckRollup: GREEN, updatedAt: "2026-10-17T08:30:00Z", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
  labels: [SESSION_LABEL], closingIssuesReferences: [], comments: [], reviews: [], reviewDecision: "REVIEW_REQUIRED", ...UNDECLARED_AUTHOR, ...over,
});

/** A not-convinced verdict at HEAD whose only finding is that no CI Acceptance run is available. The id lets `verdictBodyOf` find the body. */
const NO_RUN_VERDICT = (number: number, id = 9001) => ({
  id, author: { login: "reviewer-bot" }, createdAt: "2026-10-17T08:40:00Z",
  body: [`**Review of #${number} at \`${HEAD.slice(0, 8)}\``, "Not convinced: the acceptance is not met.", "", "- no CI Acceptance run is available for this head."].join("\n"),
});
/** A not-convinced verdict with a second finding beside the missing run: NOT woken on. */
const MIXED_VERDICT = (number: number, id = 9002) => ({
  id, author: { login: "reviewer-bot" }, createdAt: "2026-10-17T08:40:00Z",
  body: [`**Review of #${number} at \`${HEAD.slice(0, 8)}\``, "Not convinced: the acceptance is not met.", "", "- no CI Acceptance run is available for this head.", "- the test does not reach the gate."].join("\n"),
});

const decided = (prs: Pr[], outsideSessionPr: boolean) => decide({ prs, readyRows: [], nowMs: NOW, required: REQUIRED, identities: IDENTITIES, prOwnerRouting: true, ownerlessAsk: false, outsideSessionPr }) as Order[];
const onSubject = (orders: Order[], number: number) => orders.filter((o) => o.subject === `pr-agent-org#${number}`);

test("the flag is a machinery flag in the registry, and absent or off is OFF", () => {
  assert.equal(SESSION_PR_OUTSIDE_FLAG, "reviews.outsideSessionPr");
  assert.ok(FLAG_REGISTRY.includes(SESSION_PR_OUTSIDE_FLAG), "reviews.outsideSessionPr is in FLAG_REGISTRY, so machinery:flag can name it");
  assert.equal(outsideSessionPrFlagOn({ asked: undefined }, () => emptyCanaryState()), false, "absent is OFF");
  assert.equal(outsideSessionPrFlagOn({ asked: true }, () => emptyCanaryState()), true, "a reading the caller passes is used as given");
});

test("the signal is a standard machinery signal, named as the row names it", () => {
  assert.equal(MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE, "session-pr-classed-outside");
  assert.ok(STANDARD_MACHINERY_SIGNALS.includes("session-pr-classed-outside"));
});

test("the wake reads only a body whose every finding is the missing Acceptance run", () => {
  assert.equal(onlyNoAcceptanceRun("Not convinced: x\n\n- no CI Acceptance run is available for this head."), true, "POSITIVE: the one finding is the missing run");
  assert.equal(onlyNoAcceptanceRun("Not convinced: x\n\n1. No CI Acceptance run is available."), true, "POSITIVE: a numbered finding counts too");
  assert.equal(onlyNoAcceptanceRun("Not convinced: x\n\n- no CI Acceptance run is available.\n- the test does not reach the gate."), false, "NEGATIVE: a second finding is not only the missing run");
  assert.equal(onlyNoAcceptanceRun("Not convinced: no CI Acceptance run is available, and the test is wrong."), false, "NEGATIVE: the phrase in prose is not a finding");
  assert.equal(onlyNoAcceptanceRun("Not convinced: the acceptance is not met."), false, "NEGATIVE: no findings at all is not woken on");
});

test("CLASSING: a same-repository labelled pull request by an undeclared author is OUTSIDE; a declared author, a fork and an unlabelled one are not", () => {
  const declared = prOf(1, { ...DECLARED_AUTHOR });
  const fork = prOf(2, { ...FORK_AUTHOR });
  const unlabelled = prOf(3, { labels: [] });
  const own = prOf(4);
  assert.equal(reviewTrustOf(own as never, IDENTITIES), OUTSIDE, "the session's own pull request reads OUTSIDE, which is the defect");
  assert.equal(reviewTrustOf(declared as never, IDENTITIES), INSIDE, "CONTROL: a declared login is INSIDE");
  const classed = classedOutsideSessionPrs([declared, fork, unlabelled, own], IDENTITIES).map((pr) => pr.number);
  assert.deepEqual(classed, [4], "only the labelled, same-repository, undeclared pull request is classed; the three controls are not");
});

test("WAKE, POSITIVE: flag on, a same-repository labelled pull request's not-convinced no-run verdict reaches its session; flag off, nothing does (positive control)", () => {
  const prs = [prOf(1640, { comments: [NO_RUN_VERDICT(1640)] })];
  assert.ok(sessionPrVerdictWakes(prs, IDENTITIES).has("pr-agent-org#1640"), "the wake set names the pull request");
  const on = onSubject(decided(prs, true), 1640).find((o) => o.cause === "verdict-not-convinced");
  assert.ok(on, `flag on keeps the verdict order; got ${JSON.stringify(onSubject(decided(prs, true), 1640))}`);
  assert.equal(on.session, SESSION, "the order is addressed to the reader, the session on the label");
  assert.equal(onSubject(decided(prs, false), 1640).length, 0, "POSITIVE CONTROL: flag off withholds the same verdict, as before");
});

test("WAKE, NEGATIVE: a mixed-findings verdict, a fork, a declared author and an unlabelled outsider earn no wake", () => {
  assert.equal(sessionPrVerdictWakes([prOf(1641, { comments: [MIXED_VERDICT(1641)] })], IDENTITIES).size, 0, "a second finding is not woken on");
  assert.equal(sessionPrVerdictWakes([prOf(1642, { ...FORK_AUTHOR, comments: [NO_RUN_VERDICT(1642)] })], IDENTITIES).size, 0, "a fork is not woken on");
  assert.equal(sessionPrVerdictWakes([prOf(1643, { ...DECLARED_AUTHOR, comments: [NO_RUN_VERDICT(1643)] })], IDENTITIES).size, 0, "a declared-login pull request is not woken on");
  assert.equal(sessionPrVerdictWakes([prOf(1644, { labels: [], comments: [NO_RUN_VERDICT(1644)] })], IDENTITIES).size, 0, "an unlabelled outsider is not woken on");
  assert.equal(onSubject(decided([prOf(1644, { labels: [], comments: [NO_RUN_VERDICT(1644)] })], true), 1644).length, 0, "and the unlabelled outsider gets no order at all, flag on");
});

test("GENUINE OUTSIDER: a fork's not-convinced verdict is withheld with the flag on, as before", () => {
  const prs = [prOf(1645, { ...FORK_AUTHOR, labels: [], comments: [NO_RUN_VERDICT(1645)] })];
  assert.equal(onSubject(decided(prs, true), 1645).length, 0, "a genuine outsider is ordered nothing");
  assert.equal(onSubject(decided(prs, false), 1645).length, 0, "and with the flag off it is still nothing");
});

test("FLAG OFF: the orders of an ordinary tick are unchanged by the flag, a red build of a declared pull request included", () => {
  const prs = [prOf(1646, { ...DECLARED_AUTHOR, statusCheckRollup: [SETTLED("gate", "FAILURE")], comments: [NO_RUN_VERDICT(1646)] })];
  assert.ok(onSubject(decided(prs, false), 1646).length > 0, "POSITIVE CONTROL: the declared pull request earns its orders with the flag off");
  assert.deepEqual(decided(prs, true), decided(prs, false), "a declared pull request is not touched by the flag");
});

test("SIGNAL: the reader names a classed pull request only with the flag on, and null when the pull requests are unread", () => {
  const prs = [prOf(1647)];
  assert.deepEqual(sessionPrOutsideNow({ on: true, prs, declared: IDENTITIES }), [{ number: 1647, author: "worker-account-1667", session: SESSION }]);
  assert.equal(sessionPrOutsideNow({ on: false, prs, declared: IDENTITIES }), null, "flag off is null, so the canary keeps its clocks and trips nothing");
  assert.equal(sessionPrOutsideNow({ on: true, prs: null, declared: IDENTITIES }), null, "unread is null, not zero");
});

test("CLOCK: the signal counts a pull request classed OUTSIDE at 10 minutes and not at 9", () => {
  // The minutes are written out, not taken from the constant, so a constant moved to 9 is a red test (the constant is pinned below too).
  assert.equal(SESSION_PR_OUTSIDE_MINUTES, 10);
  const T0 = Date.parse("2026-10-17T09:00:00Z");
  const facts = (outside: number[] | null) => ({ claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, sessionPrOutside: outside });
  const first = machineryValues({ facts: facts([1647]), since: T0 - 60_000, now: T0, memo: {} });
  assert.equal(first.values[MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE], 0, "a first sighting has no age");
  const at9 = machineryValues({ facts: facts([1647]), since: T0, now: T0 + 9 * 60_000, memo: first.memo });
  assert.equal(at9.values[MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE], 0, "at 9 minutes it does not trip");
  const at10 = machineryValues({ facts: facts([1647]), since: T0 + 9 * 60_000, now: T0 + 10 * 60_000, memo: first.memo });
  assert.equal(at10.values[MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE], 1, "at 10 minutes it trips");
});

test("NAMED READING: a classed pull request trips at 10 minutes, named by author and session; at 9 it is clear; OFF is no reading; unread is unknown", () => {
  const named = (since: number, number = 1647) => ({ number, author: "worker-account-1667", session: SESSION, since });
  const at = (minutes: number) => NOW - minutes * 60_000;
  const tripped = sessionPrOutsideReadings({ now: NOW, enabled: true, prs: [named(at(11))] });
  assert.equal(tripped.length, 1);
  assert.equal(tripped[0].status, "tripped", "POSITIVE CONTROL: a pull request classed OUTSIDE for 11 minutes trips");
  assert.equal(tripped[0].signal, MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE);
  assert.match(tripped[0].detail, /#1647 by worker-account-1667 as worker-agent-org-1667, 11 min/, "the detail names the pull request, its author and its session");
  assert.equal(sessionPrOutsideReadings({ now: NOW, enabled: true, prs: [named(at(9))] })[0].status, "clear", "NEGATIVE CONTROL: at 9 minutes it is clear");
  assert.deepEqual(sessionPrOutsideReadings({ now: NOW, enabled: false, prs: [named(at(11))] }), [], "OFF gives no reading at all, so no order");
  assert.equal(sessionPrOutsideReadings({ now: NOW, enabled: true, prs: null })[0].status, "unknown", "a refused read is unknown, not clear");
});

test("NAMED READING, CONTROL: a declared-login pull request beside a classed one is not named", () => {
  const prs = [prOf(1647), prOf(1648, { ...DECLARED_AUTHOR })];
  const named = sessionPrOutsideNow({ on: true, prs, declared: IDENTITIES }) ?? [];
  const reading = sessionPrOutsideReading({ now: NOW, prs: named.map((pr) => ({ ...pr, since: NOW - 11 * 60_000 })) });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#1647 by/, "POSITIVE CONTROL: the undeclared-author pull request is named");
  assert.doesNotMatch(reading.detail, /#1648/, "NEGATIVE CONTROL: the declared-author pull request is not named");
});

test("CLOCK: a pull request classed OUTSIDE by a declared-login or a fork is never counted", () => {
  const prs = [prOf(1648, { ...DECLARED_AUTHOR }), prOf(1649, { ...FORK_AUTHOR })];
  assert.deepEqual(sessionPrOutsideNow({ on: true, prs, declared: IDENTITIES }), []);
  const T0 = Date.parse("2026-10-17T09:00:00Z");
  const seen = machineryValues({ facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, sessionPrOutside: [] }, since: T0 - 60_000, now: T0, memo: {} });
  const later = machineryValues({ facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, sessionPrOutside: [] }, since: T0, now: T0 + 60 * 60_000, memo: seen.memo });
  assert.equal(later.values[MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE], 0, "an empty list counts nothing, however long");
});

test("the flag's switch: the reading comes from machinery, and the flag is OFF when absent", () => {
  const on = withMachineryFlag(emptyCanaryState(), { name: SESSION_PR_OUTSIDE_FLAG, on: true, signals: STANDARD_MACHINERY_SIGNALS });
  assert.equal(outsideSessionPrFlagOn({ asked: undefined }, () => on), true, "ON when machinery says so");
  assert.equal(outsideSessionPrFlagOn({ asked: undefined }, () => emptyCanaryState()), false, "OFF when machinery is silent");
});
