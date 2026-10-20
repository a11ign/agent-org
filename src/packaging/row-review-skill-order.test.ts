// no-token: gh -- the pull requests are in memory and the order is built by `perPullRequestOrders`/`decide`; nothing here spawns `gh` or reaches a tracker.
/**
 * agent-org#1268: THE REVIEWER'S ORDER NAMES THE `row-review` SKILL ONLY BEHIND `review.rowReviewSkill`.
 * Flag off, the order is the old sentence with the contradiction (it asked for one comment where the role file says to post none) removed; flag on, it names the skill and sends
 * the verdict to the role file's way of posting. The flag is read where orders are decided, so the reading that matters is `decide`'s, not `perPullRequestOrders`' alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { perPullRequestOrders } from "../work-gate/pr-orders.ts";
import { ROW_REVIEW_SKILL_FLAG } from "../work-gate/pr-orders/pr-gate-readings.ts";
import { decide, rowReviewSkillFlagOn } from "../work-gate/tick/tick-decisions-and-flags.ts";
import { FLAG_REGISTRY } from "../machinery-flag.ts";
import { emptyCanaryState } from "../org-health/fleet-build-readings.ts";
import { withMachineryFlag } from "../org-health.ts";
import { HOME_CHECKOUT } from "../project-config.ts";

const NOW = Date.parse("2026-10-13T10:20:00Z");
const HEAD = "1268face1268face1268face1268face1268face";
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-13T10:00:00Z" }];
const RELATIVE = ".agent-org/roles/reviewer.md";
/** #1311: the author is a declared identity, so the order is the INSIDE one these tests were written against. */
const DECLARED = { exact: ["worker-1"], pattern: [] };
const awaiting = (number: number, repoKey?: string) => ({
  number, headRefOid: HEAD, isDraft: false, isCrossRepository: false, statusCheckRollup: GREEN, updatedAt: "2026-10-13T09:50:00Z", mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN", headRefName: `agent/some-slug-${number}`, comments: [], closingIssuesReferences: [],
  author: { login: "worker-1" }, reviewDecision: null, labels: [], reviews: [], ...(repoKey === undefined ? {} : { repoKey, repo: `a11ign/${repoKey}` }),
});
const promptOf = (orders: unknown[]): string => {
  const asked = (orders as { cause: string; prompt: string; }[]).filter((o) => o.cause === "draft-awaiting-verdict");
  assert.equal(asked.length, 1, "the pull request earns one reviewer order");
  return asked[0].prompt;
};

test("flag OFF (omitted or false): the order is the old sentence with the contradiction removed and names no skill", () => {
  const omitted = promptOf(perPullRequestOrders([awaiting(1268)] as never, null, null, { nowMs: NOW, identities: DECLARED }));
  const off = promptOf(perPullRequestOrders([awaiting(1268)] as never, null, null, { nowMs: NOW, identities: DECLARED, rowReviewSkill: false }));
  assert.equal(omitted, off);
  assert.ok(off.endsWith(`Review it per ${RELATIVE} and post the verdict as it says.`), off);
  assert.doesNotMatch(off, /leave one comment|row-review/, "the reviewer role file says to post no comment, so the order may not ask for one, whatever the flag says");
});

test("flag ON: the order names `row-review` and sends the verdict to the role file's way of posting", () => {
  const on = promptOf(perPullRequestOrders([awaiting(1268)] as never, null, null, { nowMs: NOW, identities: DECLARED, rowReviewSkill: true }));
  assert.ok(on.endsWith(`Review it with the \`row-review\` skill, then post the verdict per ${RELATIVE}.`), on);
  assert.doesNotMatch(on, /leave one comment/);
});

test("flag ON differs from OFF in that last sentence only: the same state, the same head and the same key", () => {
  const [off] = perPullRequestOrders([awaiting(1268)] as never, null, null, { nowMs: NOW, identities: DECLARED }) as { prompt: string; causeKey: string; discriminator: string; }[];
  const [on] = perPullRequestOrders([awaiting(1268)] as never, null, null, { nowMs: NOW, identities: DECLARED, rowReviewSkill: true }) as typeof off[];
  assert.equal(on.causeKey, off.causeKey);
  assert.equal(on.discriminator, off.discriminator);
  const stem = (p: string) => p.slice(0, p.indexOf("Review it "));
  assert.equal(stem(on.prompt), stem(off.prompt));
});

test("a keyed repository's reviewer is sent to the role file under the project root either way", () => {
  const keyed = join(HOME_CHECKOUT, RELATIVE);
  assert.ok(promptOf(perPullRequestOrders([awaiting(1139, "agent-org")] as never, null, null, { nowMs: NOW, identities: DECLARED, rowReviewSkill: true })).endsWith(`then post the verdict per ${keyed}.`));
  assert.ok(promptOf(perPullRequestOrders([awaiting(1139, "agent-org")] as never, null, null, { nowMs: NOW, identities: DECLARED })).endsWith(`Review it per ${keyed} and post the verdict as it says.`));
});

// --- the flag's reading, where the orders are decided ----------------------------------------------------------------------

test("the flag is `review.rowReviewSkill`, a flag `machinery:flag` can switch", () => {
  assert.equal(ROW_REVIEW_SKILL_FLAG, "review.rowReviewSkill");
  assert.ok(FLAG_REGISTRY.includes(ROW_REVIEW_SKILL_FLAG));
});

test("rowReviewSkillFlagOn: a caller's reading wins; otherwise the canary state's, ON only when the record says so", () => {
  assert.equal(rowReviewSkillFlagOn({ asked: true }, () => { throw new Error("must not read"); }), true);
  assert.equal(rowReviewSkillFlagOn({ asked: false }, () => { throw new Error("must not read"); }), false);
  assert.equal(rowReviewSkillFlagOn({ asked: undefined }, () => emptyCanaryState()), false);
  assert.equal(rowReviewSkillFlagOn({ asked: undefined }, () => withMachineryFlag(emptyCanaryState(), { name: ROW_REVIEW_SKILL_FLAG, on: true })), true);
  assert.equal(rowReviewSkillFlagOn({ asked: undefined }, () => withMachineryFlag(emptyCanaryState(), { name: ROW_REVIEW_SKILL_FLAG, on: false })), false);
  assert.equal(rowReviewSkillFlagOn({ asked: undefined }, () => withMachineryFlag(emptyCanaryState(), { name: "queue.chainWaitWake", on: true })), false, "another flag's switch is not this one's");
});

test("`decide` carries the reading into the order: the flag on in `decide` is the skill named in the reviewer's order", () => {
  // THE MUTANT: dropping `rowReviewSkill:` from `decide`'s `perPullRequestOrders` call keeps every direct call above green and the production order unchanged.
  const reviewerPrompt = (rowReviewSkill: boolean) => {
    const orders = decide({ prs: [awaiting(1268)], readyRows: [], nowMs: NOW, recheck: false, rowReviewSkill, identities: DECLARED } as never) as { cause: string; prompt: string; }[];
    return promptOf(orders);
  };
  assert.match(reviewerPrompt(true), /`row-review` skill/);
  assert.doesNotMatch(reviewerPrompt(false), /row-review/);
});
