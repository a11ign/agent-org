// no-token: gh -- pure: `decide` over in-memory pull requests and the identities passed in, and `machineryValues` over in-memory facts; nothing here reaches `gh`, `git` or the network
/**
 * agent-org#1648: A RED PULL REQUEST THE CHAIRMAN OPENED WITH NO SESSION ON IT REACHES A READER, OR IT IS A HEALTH SIGNAL.
 *
 * With `prs.ownerRouting` ON, a chairman-authored pull request loses every follow-up (`withholdOutsideFollowUps`), its red build included, and
 * `ownerOfPr` names no session for it. With `prs.ownerlessAsk` ON the red build's order is kept and addressed to `orchestrator`. With it OFF,
 * the pull request is withheld as it was, and `ownerless-pr-unreached` counts it once it has gone `UNQUEUED_MINUTES` unreached.
 *
 * THE ORDER PATH IS `decide`, as in `pr-owner-routing.test.ts`: the withholding is its last step. Every ask is run against the flag-off control, where the
 * same pull request still earns its red order from the producer, so an empty result with the flag on is the filter's and not an empty fixture's.
 *
 * MUTATIONS (the row's Done-when, run by hand and recorded on the row): (a) withholding the ownerless red build instead of asking it turns the first
 * test red; (b) asking a pull request that has a live `session:` label turns the label control red; (c) the signal reading 14 minutes as 15 turns the
 * clock test red.
 *
 * agent-org#1671: the ask also reaches a pull request under `ceo` or `owner-gone`, and an approved one out of the queue past `UNQUEUED_MINUTES`, and a green
 * ejection kept as the owner's. Each order names the pull request, its owner source and the minutes, and an OUTSIDE pull request is never asked under `ceo`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../work-gate.ts";
import { OWNERLESS_ASK_FLAG, OWNERLESS_ASK_SESSION, ownerOfPr } from "../work-gate/pr-orders.ts";
import { ownerlessAskFlagOn } from "../work-gate/tick.ts";
import { FLAG_REGISTRY } from "../machinery-flag.ts";
import { DEPENDENCY_BOT_LOGIN } from "../dependency-bot-login.ts";
import { MACHINERY_SIGNALS, UNQUEUED_MINUTES, STANDARD_MACHINERY_SIGNALS, emptyCanaryState, machineryValues } from "../org-health.ts";
import { type DeclaredIdentities } from "../review-trust.ts";
import { CHAIRMAN_LOGINS } from "../work-gate/vocabulary.ts";

type Order = { session: string; cause: string; subject?: string; causeKey: string; prompt: string; };
type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-16T17:04:00Z");
const HEAD = "ab698778cafe0000";
const REQUIRED = ["gate"];
/** The identities the org declares, passed in so the test does not read the host. */
const IDENTITIES: DeclaredIdentities = { exact: [...CHAIRMAN_LOGINS, "a11ign-ai-workers"], pattern: [] };

const SETTLED = (name: string, conclusion = "SUCCESS") => ({
  name, status: "COMPLETED", conclusion, startedAt: "2026-10-16T16:00:00Z", completedAt: "2026-10-16T16:05:00Z",
});
const GREEN = [SETTLED("lint"), SETTLED("typecheck"), SETTLED("test"), SETTLED("gate")];
const RED = [SETTLED("lint"), SETTLED("typecheck"), SETTLED("test"), SETTLED("gate", "FAILURE")];

/** A pull request the chairman opened, from inside the repository: the subject of the ask. */
const CHAIRMAN_AUTHOR = { isCrossRepository: false, author: { login: "DanBeckDev" } };
/** A pull request a declared worker opened: the control that an ordinary red build is never touched by the ask. */
const ORG_AUTHOR = { isCrossRepository: false, author: { login: "a11ign-ai-workers" } };

const prOf = (number: number, over: Pr = {}): Pr => ({
  number, repo: "a11ign/agent-org", repoKey: "agent-org", headRefOid: HEAD, headRefName: `contrib-branch-${number}`, isDraft: false,
  statusCheckRollup: RED, updatedAt: "2026-10-16T16:30:00Z", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
  labels: [], closingIssuesReferences: [], comments: [], reviews: [], reviewDecision: "REVIEW_REQUIRED", ...CHAIRMAN_AUTHOR, ...over,
});

const decided = (prs: Pr[], ownerlessAsk: boolean, prOwnerRouting = true) => decide({ prs, readyRows: [], nowMs: NOW, required: REQUIRED, identities: IDENTITIES, prOwnerRouting, ownerlessAsk }) as Order[];
const onSubject = (orders: Order[], number: number) => orders.filter((o) => o.subject === `pr-agent-org#${number}`);
const asked = (orders: Order[]) => orders.filter((o) => o.session === OWNERLESS_ASK_SESSION);

test("the ask is a flag in the registry, and absent or off is OFF", () => {
  assert.equal(OWNERLESS_ASK_FLAG, "prs.ownerlessAsk");
  assert.ok(FLAG_REGISTRY.includes(OWNERLESS_ASK_FLAG), "prs.ownerlessAsk is in FLAG_REGISTRY, so machinery:flag can name it");
  assert.equal(ownerlessAskFlagOn({ asked: undefined }, () => emptyCanaryState()), false, "absent is OFF");
  assert.equal(ownerlessAskFlagOn({ asked: true }, () => emptyCanaryState()), true, "a reading the caller passes is used as given");
});

test("the signal is a standard machinery signal, named as the row names it", () => {
  assert.equal(MACHINERY_SIGNALS.OWNERLESS_PR_UNREACHED, "ownerless-pr-unreached");
  assert.ok(STANDARD_MACHINERY_SIGNALS.includes("ownerless-pr-unreached"));
});

test("POSITIVE: a chairman's red pull request with no session is asked of orchestrator within the tick, flag on", () => {
  const prs = [prOf(1639)];
  const orders = onSubject(decided(prs, true), 1639);
  const ask = orders.find((o) => o.session === OWNERLESS_ASK_SESSION);
  assert.ok(ask, `an order is addressed to ${OWNERLESS_ASK_SESSION}; got ${JSON.stringify(orders)}`);
  assert.equal(ask.cause, "pr-checks-failing");
  assert.ok(ask.causeKey.startsWith(`${OWNERLESS_ASK_SESSION}/`), `the causeKey moves with the session: ${ask.causeKey}`);
  assert.ok(!orders.some((o) => o.session === "ceo"), "nothing is still addressed to ceo");
});

test("CONTROL: the same pull request with the ask off is withheld, and the producer still orders it with routing off", () => {
  const prs = [prOf(1639)];
  assert.equal(onSubject(decided(prs, false), 1639).length, 0, "with routing on and the ask off, the red build is withheld as before");
  const unrouted = onSubject(decided(prs, false, false), 1639);
  assert.ok(unrouted.some((o) => o.cause === "pr-checks-failing"), "routing off: the producer orders the red build, so the empty result above is the filter's");
});

test("CONTROL: a live `session:` label keeps today's order, and the ask adds nothing", () => {
  const prs = [prOf(1640, { labels: [{ name: "session:worker-agent-org-1640" }] })];
  const withAsk = onSubject(decided(prs, true), 1640);
  const withoutAsk = onSubject(decided(prs, false), 1640);
  assert.deepEqual(withAsk, withoutAsk, "the labelled pull request's orders are the same with the ask on and off");
  assert.equal(asked(withAsk).length, 0, "nothing is addressed to orchestrator");
});

test("CEO: an unlabelled red pull request no session owns is asked of orchestrator, and its prompt names the source and the minutes", () => {
  const prs = [prOf(1645, ORG_AUTHOR)];
  assert.equal(ownerOfPr(prs[0]).source, "ceo", "a declared worker's pull request with no label falls to the ceo rung");
  const ask = asked(decided(prs, true))[0];
  assert.ok(ask, "the ceo-owned red build is asked of orchestrator");
  assert.equal(ask.cause, "pr-checks-failing");
  assert.ok(ask.prompt.includes("owner source is `ceo`"), `the prompt names the owner source: ${ask.prompt}`);
  assert.ok(ask.prompt.includes("64 min"), `the prompt names the minutes the red build has held (16:00 to 17:04): ${ask.prompt}`);
  assert.equal(onSubject(decided(prs, false), 1645).some((o) => o.session === "ceo" && o.cause === "pr-checks-failing"), true, "flag off: the ceo still gets the red build, as before");
});

test("CONTROL: an OUTSIDE red pull request under ceo is never asked, flag on", () => {
  const prs = [prOf(1646, { isCrossRepository: true, author: { login: "someone-outside" } })];
  assert.equal(ownerOfPr(prs[0]).source, "ceo");
  assert.equal(asked(decided(prs, true)).length, 0, "its author is not ours to wake: reviewOnlyRefs withholds it, and the ask does not take it");
});

test("OWNER-GONE: a red pull request whose owner is gone is asked of orchestrator, and flag off keeps it with product-manager", () => {
  const prs = [prOf(1647, { ...ORG_AUTHOR, closingRowsClosed: true })];
  assert.equal(ownerOfPr(prs[0]).source, "owner-gone");
  const ask = asked(decided(prs, true))[0];
  assert.ok(ask, "the owner-gone red build is asked of orchestrator");
  assert.ok(ask.prompt.includes("owner source is `owner-gone`"), `the prompt names the owner source: ${ask.prompt}`);
  assert.ok(ask.prompt.includes("64 min"), `the prompt names the minutes: ${ask.prompt}`);
  assert.ok(ask.causeKey.startsWith(`${OWNERLESS_ASK_SESSION}/pr-checks-failing/`), `the causeKey moves off product-manager: ${ask.causeKey}`);
  const off = onSubject(decided(prs, false), 1647);
  assert.ok(off.some((o) => o.session === "product-manager" && o.cause === "pr-checks-failing"), "flag off: the dead owner's red build still goes to product-manager, as before");
});

test("APPROVED: an approved pull request out of the queue past UNQUEUED_MINUTES is asked of orchestrator, naming the minutes", () => {
  const approved = { armed: false, reviewDecision: "APPROVED", statusCheckRollup: GREEN, reviews: [{ state: "APPROVED", submittedAt: "2026-10-16T16:30:00Z" }] };
  const prs = [prOf(1652, approved)];
  const ask = asked(decided(prs, true))[0];
  assert.ok(ask, "34 minutes approved and unqueued is past 15: asked");
  assert.equal(ask.cause, "pr-green-unarmed");
  assert.ok(ask.prompt.includes("owner source is `chairman-author`"), `the prompt names the owner source: ${ask.prompt}`);
  assert.ok(ask.prompt.includes("34 min"), `the prompt names the minutes approved: ${ask.prompt}`);
  assert.equal(asked(decided(prs, true, false)).length, 0, "routing off: the ask is not read, so nothing is asked");
  assert.equal(asked(decided(prs, false)).length, 0, "flag off: nothing is asked");
  assert.equal(onSubject(decided(prs, true), 1652).filter((o) => o.session === OWNERLESS_ASK_SESSION).length, 1, "exactly one order to orchestrator for the pull request");
});

test("CONTROL: an approved pull request inside UNQUEUED_MINUTES is not asked yet", () => {
  const prs = [prOf(1654, { armed: false, reviewDecision: "APPROVED", statusCheckRollup: GREEN, reviews: [{ state: "APPROVED", submittedAt: "2026-10-16T16:59:00Z" }] })];
  assert.equal(asked(decided(prs, true)).length, 0, "5 minutes approved is inside the clock");
});

test("CLOCK: an approved pull request is asked at 15 minutes and one second, and not at 14 minutes and a half", () => {
  const approvedAt = (submittedAt: string) => [prOf(1656, { armed: false, reviewDecision: "APPROVED", statusCheckRollup: GREEN, reviews: [{ state: "APPROVED", submittedAt }] })];
  assert.equal(asked(decided(approvedAt("2026-10-16T16:49:30Z"), true)).length, 0, "14 minutes 30 seconds approved is inside UNQUEUED_MINUTES");
  assert.equal(asked(decided(approvedAt("2026-10-16T16:48:59Z"), true)).length, 1, "15 minutes 1 second approved is past UNQUEUED_MINUTES");
});

test("GREEN EJECTION: a green pull request the queue ejected, with no label, is asked of orchestrator; with a live label it is not", () => {
  // A queue ejection follows an approval: REVIEW_REQUIRED would read as AWAITING_REVIEW before EJECTED (`stallReasonOf`), so the fixture is approved.
  const ejection = { removedAt: "2026-10-16T16:40:00Z" };
  const approvedReviews = { reviewDecision: "APPROVED", reviews: [{ state: "APPROVED", submittedAt: "2026-10-16T16:30:00Z" }] };
  const unlabelled = [prOf(1653, { ...CHAIRMAN_AUTHOR, ...approvedReviews, statusCheckRollup: GREEN, ejection })];
  const ask = asked(decided(unlabelled, true))[0];
  assert.ok(ask, "the green ejection is asked of orchestrator");
  assert.ok(ask.prompt.includes("24 min"), `the prompt names the minutes since the ejection: ${ask.prompt}`);
  assert.ok(decided(unlabelled, false, false).some((o) => o.subject === "pr-agent-org#1653" && o.cause === "pr-checks-failing"), "routing off: the ejection order exists");
  const labelled = [prOf(1655, { ...CHAIRMAN_AUTHOR, ...approvedReviews, statusCheckRollup: GREEN, ejection, labels: [{ name: "session:worker-agent-org-1655" }] })];
  assert.equal(asked(decided(labelled, true)).length, 0, "a live session label keeps the ejection with its owner");
});

test("CONTROL: flag OFF leaves every order as it was, the ownerless pull request's included", () => {
  const prs = [prOf(1639), prOf(1642, ORG_AUTHOR)];
  const off = decided(prs, false);
  assert.equal(asked(off).length, 0, "no order is addressed to orchestrator");
  assert.ok(!off.some((o) => o.causeKey.startsWith(`${OWNERLESS_ASK_SESSION}/`)));
});

test("the dependency bot's pull request keeps its own worker, and the ask does not take it", () => {
  const prs = [prOf(1643, { ...CHAIRMAN_AUTHOR, author: { login: DEPENDENCY_BOT_LOGIN } })];
  assert.equal(asked(decided(prs, true)).length, 0);
});

test("CLOCK: the signal counts a pull request unreached at 15 minutes and not at 14", () => {
  const T0 = Date.parse("2026-10-16T17:00:00Z");
  const facts = (ownerless: number[] | null) => ({ claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, ownerless });
  const first = machineryValues({ facts: facts([1639]), since: T0 - 60_000, now: T0, memo: {} });
  assert.equal(first.values[MACHINERY_SIGNALS.OWNERLESS_PR_UNREACHED], 0, "a first sighting has no age");
  const at14 = machineryValues({ facts: facts([1639]), since: T0, now: T0 + (UNQUEUED_MINUTES - 1) * 60_000, memo: first.memo });
  assert.equal(at14.values[MACHINERY_SIGNALS.OWNERLESS_PR_UNREACHED], 0, "at 14 minutes it does not trip");
  const at15 = machineryValues({ facts: facts([1639]), since: T0 + 14 * 60_000, now: T0 + UNQUEUED_MINUTES * 60_000, memo: first.memo });
  assert.equal(at15.values[MACHINERY_SIGNALS.OWNERLESS_PR_UNREACHED], 1, "at 15 minutes it trips");
});

test("CLOCK: an unread list is null, and the clock is kept rather than restarted", () => {
  const T0 = Date.parse("2026-10-16T17:00:00Z");
  const seen = machineryValues({ facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, ownerless: [1639] }, since: T0 - 60_000, now: T0, memo: {} });
  const unread = machineryValues({ facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, ownerless: null }, since: T0, now: T0 + UNQUEUED_MINUTES * 60_000, memo: seen.memo });
  assert.equal(unread.values[MACHINERY_SIGNALS.OWNERLESS_PR_UNREACHED], null, "unread is null, not zero");
  assert.equal(unread.memo["ownerless:1639"], T0, "the first sighting survives an unread tick");
});
