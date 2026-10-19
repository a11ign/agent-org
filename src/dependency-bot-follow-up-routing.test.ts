// no-token: gh -- pure: `decide` over in-memory pull requests and the identities passed in; nothing here reaches `gh`, `git` or the network
/**
 * agent-org#1368: WITH `prs.ownerRouting` ON, A DEPENDENCY BOT'S PULL REQUEST'S RED CHECKS, CONFLICT AND NOT-CONVINCED VERDICT GO TO A WORKER, NOT `ceo`.
 * `ownerOfPr` names no session for a bot's pull request (rung 6), so the three orders it earns were addressed to `ceo`. A bot's pull request is
 * OUTSIDE too (no declared author), so #1325 withheld every one of them. Here they are kept and addressed to the worker pool instead.
 *
 * THE ORDER PATH IS `decide`, as in `pr-owner-routing.test.ts`. Every case runs twice: flag ON, and flag OFF, where the same pull request is
 * ordered to `ceo` as it was before this row. The flag-off run is the POSITIVE CONTROL that the pull request really earns the order, so an
 * empty or `ceo` result with the flag on is the routing's, not an empty fixture's.
 *
 * MUTATION (the row's Done-when): returning `ceo` for a bot's pull request under the flag turns the first test red, because no `engineers` order exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { testEach } from "./lib/test-each.ts";
import { decide } from "./work-gate/tick/blocker-cleared-reading.ts";

type Order = { session: string; cause: string; subject?: string; causeKey: string; };
type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-13T09:00:00Z");
const HEAD = "ab698778cafe0000";
const REQUIRED = ["gate"];
/** The identities the org declares: the shared worker account is inside, Dependabot is not declared, so its pull requests are OUTSIDE. */
const IDENTITIES = { exact: ["a11ign-ai-workers"], pattern: [] };

const SETTLED = (name: string, conclusion = "SUCCESS") => ({
  name, status: "COMPLETED", conclusion, startedAt: "2026-10-13T07:00:00Z", completedAt: "2026-10-13T07:05:00Z",
});
const GREEN = [SETTLED("lint"), SETTLED("typecheck"), SETTLED("test"), SETTLED("gate")];
const RED = [SETTLED("lint"), SETTLED("typecheck"), SETTLED("test"), SETTLED("gate", "FAILURE")];

/** Dependabot's pull request as `gh pr list --json author` returns it: a same-repository branch by the bot's login, no declared identity. */
const DEPENDABOT = {
  isCrossRepository: false, author: { login: "app/dependabot" }, headRefName: "dependabot/npm_and_yarn/axe-core-4.14.0", labels: [{ name: "dependencies" }],
};
/** A pull request from an outside fork, which the bot rule must not reach: the control that a stranger's red build is still withheld. */
const STRANGER = { isCrossRepository: true, author: { login: "some-stranger" }, headRefName: "contrib-branch-stranger", labels: [] };

/** A pull request as the tests build it: Dependabot's by default, every test that is not about the bot overrides with `STRANGER`. */
const prOf = (number: number, over: Pr = {}): Pr => ({
  number, repo: "a11ign/agent-org", repoKey: "agent-org", headRefOid: HEAD, isDraft: false,
  statusCheckRollup: GREEN, updatedAt: "2026-10-13T08:00:00Z", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
  closingIssuesReferences: [], comments: [], reviews: [], reviewDecision: "REVIEW_REQUIRED", ...DEPENDABOT, ...over,
});

/** A verdict left at HEAD by a reviewer, in the opener form `reviewVerdict` reads. The word is spaced, as in `pr-owner-routing.test.ts`. */
const verdictComment = (number: number, verdict: string) => ({
  author: { login: "reviewer-bot" }, createdAt: "2026-10-13T08:30:00Z",
  body: [`**Review of #${number} at \`${HEAD.slice(0, 8)}\``, `${verdict}: the acceptance is not met.`].join("\n"),
});

const decided = (prs: Pr[], prOwnerRouting: boolean) => decide({ prs, readyRows: [], nowMs: NOW, required: REQUIRED, identities: IDENTITIES, prOwnerRouting }) as Order[];
const onlySubject = (orders: Order[], number: number) => orders.filter((o) => o.subject === `pr-agent-org#${number}`);
const workerOrders = (orders: Order[], number: number, cause: string) => onlySubject(orders, number).filter((o) => o.session === "engineers" && o.cause === cause);
const ceoOrders = (orders: Order[], number: number) => onlySubject(orders, number).filter((o) => o.session === "ceo");

const BOT_FOLLOW_UPS = [
  { name: "RED", number: 1020, over: { statusCheckRollup: RED }, cause: "pr-checks-failing", worker: "the bot's red build is a worker's to fix", ceoSilent: "ceo is not woken for the bot's red build", control: "POSITIVE CONTROL: flag off orders the bot's red build to ceo" },
  { name: "CONFLICTING", number: 1021, over: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, cause: "pr-merge-conflict", worker: "the bot's conflict is a worker's to resolve", ceoSilent: "ceo is not woken for the bot's conflict", control: "POSITIVE CONTROL: flag off orders the conflict to ceo" },
  { name: "NOT-CONVINCED", number: 1022, over: { comments: [verdictComment(1022, "Not convinced")] }, cause: "verdict-not-convinced", worker: "the bot's not-convinced verdict is a worker's rework", ceoSilent: "ceo is not woken for the bot's not-convinced verdict", control: "POSITIVE CONTROL: flag off orders the verdict to ceo" },
];

testEach("DEPENDABOT: flag on, the follow-up goes to a worker and ceo is not woken; flag off, ceo is ordered (positive control)", BOT_FOLLOW_UPS, (c) => {
  const prs = [prOf(c.number, c.over)];
  const on = decided(prs, true);
  assert.equal(workerOrders(on, c.number, c.cause).length, 1, c.worker);
  assert.deepEqual(ceoOrders(on, c.number), [], c.ceoSilent);
  assert.equal(ceoOrders(decided(prs, false), c.number).filter((o) => o.cause === c.cause).length, 1, c.control);
});

test("DEPENDABOT, OTHER FOLLOW-UPS: flag on, the bot's pull request is still withheld from ceo for every cause but the three above", () => {
  const prs = [prOf(1023, { isDraft: true, statusCheckRollup: RED })];
  const on = decided(prs, true);
  assert.deepEqual(ceoOrders(on, 1023), [], "ceo is not woken for a bot's pull request on any follow-up");
  assert.deepEqual(onlySubject(on, 1023).filter((o) => o.session === "engineers" && o.cause !== "pr-checks-failing"), []);
});

test("STRANGER, RED: flag on, a red pull request from an outside fork gets no follow-up at all, to a worker or to ceo", () => {
  const prs = [prOf(1024, { ...STRANGER, statusCheckRollup: RED })];
  assert.deepEqual(onlySubject(decided(prs, true), 1024).filter((o) => o.cause !== "draft-awaiting-verdict"), []);
  assert.ok(onlySubject(decided(prs, false), 1024).some((o) => o.cause === "pr-checks-failing"), "POSITIVE CONTROL: flag off orders the stranger's red build");
});

test("DEPENDABOT, FLAG OFF: every order is what it was before this row, and no order is addressed to a worker", () => {
  const prs = [prOf(1025, { statusCheckRollup: RED }), prOf(1026, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })];
  const off = decided(prs, false);
  assert.deepEqual(off.filter((o) => o.session === "engineers"), [], "flag off never addresses the engineers pool for a bot's pull request");
  assert.ok(workerOrders(off, 1025, "pr-checks-failing").length === 0 && ceoOrders(off, 1025).length > 0, "flag off, the red build is ceo's");
});
