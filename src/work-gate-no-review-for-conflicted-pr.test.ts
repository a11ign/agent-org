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
import { reviewableHead, reviewWait, withPatchIds } from "./work-gate.ts";

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

/**
 * a11ign/a11ign#3597: A PULL REQUEST RED ONLY ON A CHECK THAT IS NOT REQUIRED IS ASKED FOR A REVIEW. agent-org#211, #212 and #213 were green
 * on `gate` (the one required context) and red on `typecheck`: `failingChecksOrder` read the required set and ordered nothing,
 * `reviewableHead` read every check and answered `null`, so `draftOrder` returned nothing and no `reviewer-agent-org-<n>` was ever started.
 *
 * THE CONTROLS: (7) is the case itself and goes RED if `reviewableHead` reads the whole rollup again; (8) is the case that stops the fix
 * over-reaching, and differs from (7) in ONE fact (which check is red); (9) pins the unread list, which must keep the answer given before
 * #3597; (10) and (11) pin the two other callers of the same question.
 */
const REQUIRED = ["gate"];
const check = (name: string, over: Record<string, unknown>) => ({ name, status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-04T13:00:00Z", ...over });
const GATE_OK = check("gate", {});
const TYPECHECK_RED = check("typecheck", { conclusion: "FAILURE" });
const TYPECHECK_RUNNING = check("typecheck", { status: "IN_PROGRESS", conclusion: "" });
const keyedPr = (rollup: unknown[]) => prOf({ repoKey: "agent-org", repo: "a11ign/agent-org", statusCheckRollup: rollup });
const withRequired = (pr: unknown, required: string[] | null): Order[] => perPullRequestOrders([pr as object], required, null, NOW) as Order[];
const causesWith = (pr: unknown, required: string[] | null) => withRequired(pr, required).map((o) => o.cause);

test("(7) green on the REQUIRED check, red on one that is not: the review IS asked, to reviewer-agent-org-<n>", () => {
  const pr = keyedPr([GATE_OK, TYPECHECK_RED]);
  assert.deepEqual(causesWith(pr, REQUIRED), ["draft-awaiting-verdict"]);
  assert.equal(withRequired(pr, REQUIRED)[0].session, "reviewer-agent-org-148");
  assert.deepEqual(causesWith(keyedPr([GATE_OK]), REQUIRED), ["draft-awaiting-verdict"], "the positive control: the same pull request without the red check");
});

test("(8) the same pull request with the REQUIRED check red is `pr-checks-failing` and is NOT asked for a review", () => {
  const causesOf = causesWith(keyedPr([check("gate", { conclusion: "FAILURE" }), TYPECHECK_RED]), REQUIRED);
  assert.deepEqual(causesOf, ["pr-checks-failing"]);
});

test("(9) an UNREAD required list keeps the answer given before #3597: every check counts, so a red `typecheck` is the author's, never a review's", () => {
  assert.deepEqual(causesWith(keyedPr([GATE_OK, TYPECHECK_RED]), null), ["pr-checks-failing"]);
  assert.deepEqual(causesWith(keyedPr([GATE_OK]), null), ["draft-awaiting-verdict"], "the positive control");
});

test("(10) a non-required check still RUNNING beside a settled-green required one is asked now ('settled'); a REQUIRED one running is 'running'", () => {
  const nonRequiredRunning = keyedPr([GATE_OK, TYPECHECK_RUNNING]);
  assert.equal(reviewWait(nonRequiredRunning, REQUIRED), "settled");
  assert.deepEqual(causesWith(nonRequiredRunning, REQUIRED), ["draft-awaiting-verdict"]);
  assert.equal(reviewWait(keyedPr([check("gate", { status: "IN_PROGRESS", conclusion: "" }), TYPECHECK_RED]), REQUIRED), "running");
  assert.equal(reviewWait(nonRequiredRunning, null), "running", "an unread list is the answer before #3597");
  assert.equal(reviewWait(keyedPr([check("gate", { conclusion: "FAILURE" }), TYPECHECK_RUNNING]), REQUIRED), null, "red required: not this question's");
});

test("(11) withPatchIds reads the patch for the pull request the question is open for, on the same list draftOrder reads", () => {
  const compares: string[] = [];
  const run = (args: string[]) => { compares.push(args[args.length - 1]); return "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"; };
  const pr = keyedPr([GATE_OK, TYPECHECK_RED]);
  const [read] = withPatchIds([pr], run, REQUIRED) as { patchIds?: Record<string, string> }[];
  assert.deepEqual(Object.keys(read.patchIds ?? {}), [OLD_HEAD], "enriched at its head");
  assert.equal(compares.some((c) => c.includes(`compare/main...${OLD_HEAD}`)), true);
  compares.length = 0;
  const [unread] = withPatchIds([pr], run, null) as { patchIds?: unknown }[];
  assert.equal(unread.patchIds, undefined, "an unread list: red on any check, as before");
  assert.deepEqual(compares, [], "and no call is paid for it");
  assert.equal(reviewableHead(pr, REQUIRED), OLD_HEAD);
  assert.equal(reviewableHead(pr, null), null);
});
