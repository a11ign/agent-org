// no-token: gh -- pure: `withPrOwners`, `ownerOfPr`, `unresolvedOwnerEvents` and `decide` over in-memory rows and pull requests; nothing here reaches `gh`, `git` or the network
/**
 * #4644, #4808: A PULL REQUEST WHOSE OWNER ENDED AND WHOSE ROWS NOBODY HOLDS HAS AN OWNER -- `product-manager`, by the `owner-gone` rung -- and is not
 * an `owner-unresolved` event, whether the row is CLOSED (a11ign#4626) or OPEN and UNCLAIMED (a11ign#4805). #4626 (draft) carried `session:worker-4624` and
 * branch `agent/failure-class-owner-unresolved-4624`; worker-4624 ended and #4624 was closed while the PR stayed open. #4805 carried `session:worker-4804`;
 * worker-4804 ended and #4804 went back to `backlog` OPEN with no claim. Rungs 2-5 each need a LIVE session holding an OPEN claimed row, so all four
 * failed and the PR landed on `ceo`, recorded as "nobody could be named" when the owner was known.
 *
 * THE FIXTURES ARE #4626 AND #4805. CONTROLS, each the same PR with ONE fact changed: its label alive keeps the label; its row open and CLAIMED keeps
 * `closing-row`; no label naming no row still falls to `ceo` and IS recorded (so the emptiness asserted for the two is not an emptiness of the recorder); a
 * label-less PR naming an open unheld row is `owner-gone` (#5201, below); a
 * dependency bot's PR still outranks the rung; and an unreadable rows list (empty) is neither "every row closed" nor "unclaimed".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPrOwners } from "../work-gate/pr-owners.ts";
import { decide } from "../work-gate/tick/blocker-cleared-reading.ts";
import { ownerOfPr } from "../work-gate/pr-orders/red-only-by-superseded-run.ts";
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

test("CONTROL: a PR with no label that names NO row still falls to ceo and IS recorded", () => {
  const pr = owned(pr4626({ labels: [], headRefName: "agent/fix-typo", closingIssuesReferences: [] }));
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "ceo" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), [{ classKey: "owner-unresolved", ref: "a11ign/a11ign#4626" }]);
});

/**
 * #5201 (a11ign, the tenth `owner-unresolved` occurrence): a PR with NO label at all, on a branch `agent/<slug>-<n>` naming row n, which is open and held by
 * nobody. No label can name a dead owner here, so `rowsNobodyHolds` reads the row the branch names and the PR is `owner-gone`. Each CONTROL is the same PR
 * with ONE fact changed.
 */
const pr5201 = (over: Record<string, unknown> = {}) => pr4626({
  labels: [], headRefName: "agent/the-webhook-last-mile-5197", closingIssuesReferences: [], ...over,
});
const OPEN_5197 = [...OPEN, row(5197, "backlog", "lane:any")];

test("#5201: a PR with no label on a branch naming an open unheld row is owned by product-manager, source owner-gone, and is not an owner-unresolved event", () => {
  const pr = owned(pr5201(), OPEN_5197);
  assert.equal(pr.closingRowsUnheld, true);
  assert.equal(pr.closingRowsNone, undefined, "no label means no ENDED label to answer for, and the flag that says so is for a labelled PR only");
  assert.deepEqual(ownerOfPr(pr), { session: "product-manager", source: "owner-gone" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), []);
});

test("#5201 CONTROL: the same PR whose branch row is HELD by a live session keeps branch-row", () => {
  const pr = owned(pr5201({ headRefName: "agent/the-webhook-last-mile-4437" }));
  assert.deepEqual(ownerOfPr(pr), { session: "worker-4437", source: "branch-row" });
});

test("#5201: the order for an unlabelled PR says it carries no label and the row it names is open and held by nobody, and never says ENDED", () => {
  const orders = decide({ prs: [owned(pr5201({ isDraft: false }), OPEN_5197)], readyRows: [], openRows: OPEN_5197 } as never);
  const failing = orders.filter((o: any) => o.cause === "pr-checks-failing");
  assert.equal(failing.length, 1, "POSITIVE CONTROL: the red pull request is ordered at all");
  assert.equal(failing[0].session, "product-manager");
  assert.match(failing[0].prompt, /[Ii]t carries no `session:` label, and the row it names is open and no session holds it/);
  assert.doesNotMatch(failing[0].prompt, /ENDED|NOBODY COULD BE NAMED/);
});

test("CONTROL: a rows read that came back empty is neither 'every row closed' nor 'unclaimed'", () => {
  assert.equal(ownerOfPr(owned(pr4626(), [])).source, "ceo");
});

test("#5115: a PR naming no row with an ENDED label is owner-gone too (the row's no-row shape), and with NO label it is still ceo", () => {
  assert.deepEqual(ownerOfPr(owned(pr4626({ headRefName: "agent/some-slug", closingIssuesReferences: [] }))), { session: "product-manager", source: "owner-gone" });
  assert.deepEqual(ownerOfPr(owned(pr4626({ labels: [], headRefName: "agent/some-slug", closingIssuesReferences: [] }))), { session: "ceo", source: "ceo" });
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

/**
 * #5115 (a11ign, the eighth `owner-unresolved` occurrence): a pull request whose owner ENDED and which closes NO row (`Closes: none -- <reason>`).
 * Its body names no row, so `rowsNobodyHolds` has nothing to read; the owner is still known and gone, so it is `owner-gone`, not `ceo`. Each CONTROL
 * is the same PR with ONE fact changed.
 */
const NONE = { ...ENDED, agents: () => ["worker-4437"], ended: () => new Map([["worker-5109", 1]]) };
const pr5115 = (over: Record<string, unknown> = {}) => ({
  number: 5115, headRefOid: "beef5115ef560000", isDraft: false, statusCheckRollup: RED, headRefName: "agent/pm-brief-half",
  author: { login: "a11ign-ai-workers" }, labels: [{ name: "session:worker-5109" }], closingIssuesReferences: [],
  body: "Closes: none -- the row closes on a11ign/agent-org#1007; this PR is the product-manager brief half.", ...over,
});

test("#5115: a label that ENDED on a PR closing no row is owned by product-manager, source owner-gone, and is not an owner-unresolved event", () => {
  const pr = owned(pr5115(), OPEN, NONE);
  assert.equal(pr.closingRowsNone, true);
  assert.deepEqual(ownerOfPr(pr), { session: "product-manager", source: "owner-gone" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), []);
});

test("#5115: the order says the owner ENDED and the PR closes no row, not 'nobody could be named'", () => {
  const orders = decide({ prs: [owned(pr5115(), OPEN, NONE)], readyRows: [], openRows: OPEN } as never);
  const failing = orders.filter((o: any) => o.cause === "pr-checks-failing");
  assert.equal(failing.length, 1, "POSITIVE CONTROL: the red pull request is ordered at all");
  assert.equal(failing[0].session, "product-manager");
  assert.match(failing[0].prompt, /label names `worker-5109`, which has ENDED, and it closes no row/);
  assert.doesNotMatch(failing[0].prompt, /NOBODY COULD BE NAMED/);
});

test("CONTROL: the same PR with its label ALIVE keeps the label", () => {
  const pr = owned(pr5115(), OPEN, { ...NONE, agents: () => ["worker-4437", "worker-5109"] });
  assert.deepEqual(ownerOfPr(pr), { session: "worker-5109", source: "label" });
});

test("CONTROL: the same PR with the rows read EMPTY (the read was refused) still falls to ceo, and is not flagged", () => {
  const pr = owned(pr5115(), [], NONE);
  assert.equal(pr.closingRowsNone, undefined);
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "ceo" });
});

test("CONTROL: the same PR with NO label at all still falls to ceo and IS recorded", () => {
  const pr = owned(pr5115({ labels: [] }), OPEN, NONE);
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "ceo" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), [{ classKey: "owner-unresolved", ref: "a11ign/a11ign#5115" }]);
});

test("CONTROL: the same PR naming an open row a LIVE session holds keeps closing-row", () => {
  const pr = owned(pr5115({ closingIssuesReferences: [{ number: 4437 }] }), OPEN, NONE);
  assert.equal(pr.closingRowsNone, undefined);
  assert.deepEqual(ownerOfPr(pr), { session: "worker-4437", source: "closing-row" });
});
