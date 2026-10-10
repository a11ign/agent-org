// no-token: gh -- pure: `withPrOwners`, `ownerOfPr`, `unresolvedOwnerEvents` and `decide` over in-memory rows and pull requests; nothing here reaches `gh`, `git` or the network
/**
 * #4644, #4808: A PULL REQUEST WHOSE OWNER ENDED AND WHOSE ROWS NOBODY HOLDS HAS AN OWNER -- `product-manager`, by the `owner-gone` rung -- and is not
 * an `owner-unresolved` event, whether the row is CLOSED (a11ign#4626) or OPEN and UNCLAIMED (a11ign#4805). #4626 (draft) carried `session:worker-4624` and
 * branch `agent/failure-class-owner-unresolved-4624`; worker-4624 ended and #4624 was closed while the PR stayed open. #4805 carried `session:worker-4804`;
 * worker-4804 ended and #4804 went back to `backlog` OPEN with no claim. Rungs 2-5 each need a LIVE session holding an OPEN claimed row, so all four
 * failed and the PR landed on `ceo`, recorded as "nobody could be named" when the owner was known.
 *
 * THE FIXTURES ARE #4626 AND #4805. CONTROLS, each the same PR with ONE fact changed: its label alive keeps the label; its row open and CLAIMED keeps
 * `closing-row`; no label at all still falls to `ceo` and IS recorded (so the emptiness asserted for the two is not an emptiness of the recorder); a
 * dependency bot's PR still outranks the rung; and an unreadable rows list (empty) is neither "every row closed" nor "unclaimed".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPrOwners, decide } from "../work-gate.ts";
import { ownerOfPr } from "../work-gate/pr-orders.ts";
import { unresolvedOwnerEvents } from "../pr-ownership.ts";

const row = (number: number, ...labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });
/** Open rows the gate read: #4624 is NOT among them (closed); #4437 is an unrelated open one. */
const OPEN = [row(4437, "in-progress", "session:worker-4437")];
const ENDED = { agents: () => ["worker-4437"], ended: () => new Map([["worker-4624", 1]]), say: () => {} };
const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-09T20:00:00Z" }];

const pr4626 = (over: Record<string, unknown> = {}) => ({
  number: 4626, headRefOid: "cafe1234ef560000", isDraft: true, statusCheckRollup: RED, headRefName: "agent/failure-class-owner-unresolved-4624",
  author: { login: "a11ign-ai-workers" }, labels: [{ name: "session:worker-4624" }], closingIssuesReferences: [{ number: 4624 }], ...over,
});
const owned = (pr: Record<string, unknown>, rows: unknown[] = OPEN, io: typeof ENDED = ENDED) => withPrOwners([pr], rows as never, () => null, io)[0];

test("the #4626 shape is owned by product-manager, source owner-gone, and is not an owner-unresolved event", () => {
  const pr = owned(pr4626());
  assert.deepEqual(ownerOfPr(pr), { session: "product-manager", source: "owner-gone" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), []);
});

test("CONTROL: the same PR with its label ALIVE keeps the label", () => {
  const pr = owned(pr4626(), OPEN, { ...ENDED, agents: () => ["worker-4437", "worker-4624"] });
  assert.deepEqual(ownerOfPr(pr), { session: "worker-4624", source: "label" });
});

test("CONTROL: the same PR with its closing row OPEN and claimed keeps closing-row", () => {
  const pr = owned(pr4626(), [...OPEN, row(4624, "in-progress", "session:worker-9")]);
  assert.deepEqual(ownerOfPr(pr), { session: "worker-9", source: "closing-row" });
});

test("the #4805 shape: label ENDED, closing row OPEN with NO claim, is owned by product-manager, source owner-gone, and is not an owner-unresolved event", () => {
  const pr = owned(pr4626({ labels: [{ name: "session:worker-4804" }], closingIssuesReferences: [{ number: 4804 }], headRefName: "agent/the-core-s-scorer-4804" }),
    [...OPEN, row(4804, "backlog", "lane:any"), row(1)], { ...ENDED, ended: () => new Map([["worker-4804", 1]]) });
  assert.equal(pr.closingRowsUnheld, true);
  assert.equal(pr.closingRowsClosed, undefined, "the row is open: the closed flag is for a closed row, and the words depend on which one it was");
  assert.deepEqual(ownerOfPr(pr), { session: "product-manager", source: "owner-gone" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), []);
});

test("the row open but UNCLAIMED (a released label with no `in-progress` is one too) is owner-gone, where it used to fall to ceo and be recorded", () => {
  for (const unclaimed of [row(4624), row(4624, "session:worker-4624"), row(4624, "in-progress")]) {
    const pr = owned(pr4626(), [...OPEN, unclaimed]);
    assert.deepEqual(ownerOfPr(pr), { session: "product-manager", source: "owner-gone" }, JSON.stringify(unclaimed));
    assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), []);
  }
});

test("CONTROL: a PR naming one row held by a live session and one open and UNCLAIMED keeps closing-row; two live holders stay a split and fall to ceo", () => {
  const held = owned(pr4626({ closingIssuesReferences: [{ number: 4624 }, { number: 4625 }] }), [...OPEN, row(4624), row(4625, "in-progress", "session:worker-9")]);
  assert.deepEqual(ownerOfPr(held), { session: "worker-9", source: "closing-row" });
  const split = owned(pr4626({ closingIssuesReferences: [{ number: 4624 }, { number: 4625 }] }),
    [...OPEN, row(4624, "in-progress", "session:worker-8"), row(4625, "in-progress", "session:worker-9")]);
  assert.equal(ownerOfPr(split).source, "ceo");
});

test("CONTROL: a PR with no label at all still falls to ceo and IS recorded", () => {
  const pr = owned(pr4626({ labels: [] }));
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "ceo" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), [{ classKey: "owner-unresolved", ref: "a11ign/a11ign#4626" }]);
});

test("CONTROL: a rows read that came back empty is neither 'every row closed' nor 'unclaimed', and a PR naming no row has nothing to be either", () => {
  assert.equal(ownerOfPr(owned(pr4626(), [])).source, "ceo");
  assert.equal(ownerOfPr(owned(pr4626({ headRefName: "agent/some-slug", closingIssuesReferences: [] }))).source, "ceo");
});

test("a dependency bot's PR still outranks the rung, and a live session the branch names outranks it too", () => {
  assert.deepEqual(ownerOfPr(owned(pr4626({ author: { login: "app/dependabot" } }))), { session: "ceo", source: "dependency-bot" });
  const named = owned(pr4626({ headRefName: "agent/worker-4437-4624" }));
  assert.deepEqual(ownerOfPr(named), { session: "worker-4437", source: "branch-name" });
});

test("a red #4626 is ordered to product-manager in words that name the ended owner, not 'nobody could be named'", () => {
  const orders = decide({ prs: [owned(pr4626({ isDraft: false }))], readyRows: [], openRows: OPEN } as never);
  const failing = orders.filter((o: any) => o.cause === "pr-checks-failing");
  assert.equal(failing.length, 1, "POSITIVE CONTROL: the red pull request is ordered at all");
  assert.equal(failing[0].session, "product-manager");
  assert.match(failing[0].prompt, /label names `worker-4624`, which has ENDED, and the row it closed is closed/);
  assert.doesNotMatch(failing[0].prompt, /NOBODY COULD BE NAMED/);
});

test("the order's words say what state the row is in: 'is closed' for a closed row, 'open and no session holds it' for an open one", () => {
  const sentence = (rows: unknown[]) => {
    const orders = decide({ prs: [owned(pr4626({ isDraft: false }), rows)], readyRows: [], openRows: rows } as never);
    return orders.filter((o: any) => o.cause === "pr-checks-failing")[0].prompt as string;
  };
  const unclaimed = sentence([...OPEN, row(4624)]);
  assert.match(unclaimed, /label names `worker-4624`, which has ENDED, and the row it closes is open and no session holds it/);
  assert.doesNotMatch(unclaimed, /is closed|NOBODY COULD BE NAMED/);
  assert.match(sentence(OPEN), /the row it closed is closed/, "and the closed row keeps its words");
});
