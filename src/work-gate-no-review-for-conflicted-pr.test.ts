// no-token: gh -- pure: `perPullRequestOrders` and `stallReasonOf` over in-memory pull requests; nothing reaches `gh`, `git` or herdr
/**
 * #3476: A PULL REQUEST THAT CONFLICTS WITH ITS BASE IS NOT ASKED FOR A FIRST REVIEW OF THAT HEAD.
 *
 * THE DEFECT, a11ign/agent-org#148, 2026-10-04: #145 merged at 13:37:16Z and made it DIRTY; its reviewer approved at 13:44:58Z, 7m42s
 * later, at a head the rebase had to replace. `draftOrder` read red, then a settled green head, and never asked whether the pull request
 * could merge, so a DIRTY one sat in the reviewer lane exactly as a clean one does.
 *
 * THE CONTROLS ARE THE ROW'S: (2) is the non-empty case (1)'s emptiness is read against, and (2) and (4) each differ from (1) in ONE fact
 * (the merge state; the head and the merge state). (5) pins the other direction: a verdict already given is not withdrawn by a conflict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { perPullRequestOrders, stallReasonOf } from "./work-gate/pr-orders.mjs";

type Order = { session: string, cause: string, causeKey: string, discriminator: string, prompt: string };

const NOW = Date.parse("2026-10-04T14:00:00Z");
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-04T13:00:00Z" }];
const DIRTY = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
const CLEAN = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
const UNREAD = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
const OLD_HEAD = "97222d54aaaaaaaa";
const NEW_HEAD = "67055412bbbbbbbb";

const prOf = (over: Record<string, unknown> = {}) => ({
  number: 148, headRefOid: OLD_HEAD, isDraft: false, statusCheckRollup: GREEN, updatedAt: "2026-10-04T13:59:00Z",
  headRefName: "agent/some-slug-3419", labels: [{ name: "session:worker-3419" }], closingIssuesReferences: [], comments: [], reviews: [],
  author: { login: "worker-3419" }, ...CLEAN, ...over,
});
const ordersOf = (pr: unknown): Order[] => perPullRequestOrders([pr as object], null, null, NOW) as Order[];
const requests = (pr: unknown): Order[] => ordersOf(pr).filter((o) => o.cause === "draft-awaiting-verdict");
const causes = (pr: unknown) => ordersOf(pr).map((o) => o.cause);

test("(1) the #148 fixture: green, READY, DIRTY, no verdict -- NO review request, and the stall reading is still CONFLICTED", () => {
  const dirty = prOf(DIRTY);
  assert.deepEqual(ordersOf(dirty), []);
  assert.equal(stallReasonOf(dirty, null, NOW), "conflicted", "the owner's pr-merge-conflict reading of the same fixture is unchanged");
});

test("(2) the positive control, one fact different: the same pull request CLEAN yields exactly one request, to its reviewer", () => {
  const [order, ...rest] = requests(prOf(CLEAN));
  assert.ok(order, "the clean twin must be ordered -- or (1)'s emptiness is vacuous");
  assert.equal(rest.length, 0);
  assert.equal(order.session, "reviewer-148");
  assert.equal(ordersOf(prOf(CLEAN)).length, 1);
});

test("(3) an UNREAD merge state is not an accusation: UNKNOWN / UNKNOWN still asks for the review", () => {
  assert.deepEqual(requests(prOf(UNREAD)).map((o) => o.session), ["reviewer-148"]);
});

test("(4) the rebase: the conflicted head is asked of nobody; the new, clean head is asked ONCE", () => {
  assert.deepEqual(ordersOf(prOf(DIRTY)), []);
  const rebased = requests(prOf({ headRefOid: NEW_HEAD, ...CLEAN }));
  assert.equal(rebased.length, 1);
  assert.equal(rebased[0].discriminator, NEW_HEAD.slice(0, 8));
  assert.equal(rebased[0].causeKey, `reviewer-148/draft-awaiting-verdict/pr-148/${NEW_HEAD.slice(0, 8)}`);
  assert.equal(rebased.some((o) => o.causeKey.endsWith(`/${OLD_HEAD.slice(0, 8)}`)), false, "nothing is keyed to the head the rebase replaced");
});

test("(5) a verdict already GIVEN is not withdrawn by a conflict: rework is still owed, a convinced draft is still marked ready", () => {
  const comment = (body: string) => [{ author: { login: "reviewer-148" }, createdAt: "2026-10-04T13:44:58Z", body }];
  const refused = prOf({ ...DIRTY, comments: comment("Re-read of `97222d54` -- **not convinced**.") });
  assert.deepEqual(causes(refused), ["verdict-not-convinced"]);
  assert.deepEqual(causes(prOf({ ...CLEAN, comments: refused.comments })), ["verdict-not-convinced"], "the clean twin gets the same order");

  const approved = comment("**Review of #148 at `97222d54`, by reviewer-148: convinced.**");
  const draft = prOf({ ...DIRTY, isDraft: true, comments: approved });
  assert.deepEqual(causes(draft), ["draft-convinced-not-ready"]);
  assert.deepEqual(causes(prOf({ ...CLEAN, isDraft: true, comments: approved })), ["draft-convinced-not-ready"], "the clean twin gets the same order");
});

test("(6) a KEYED repository's conflicted pull request is withheld the same way, and its clean twin goes to reviewer-agent-org-<n>", () => {
  const keyed = { repoKey: "agent-org", repo: "a11ign/agent-org" };
  assert.deepEqual(ordersOf(prOf({ ...keyed, ...DIRTY })), []);
  const [order, ...rest] = requests(prOf({ ...keyed, ...CLEAN }));
  assert.ok(order, "the keyed clean twin must be ordered");
  assert.equal(rest.length, 0);
  assert.equal(order.session, "reviewer-agent-org-148");
});
