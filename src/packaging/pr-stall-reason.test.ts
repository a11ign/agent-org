// no-token: #2968 -- nothing here runs `gh`; every pull request is a literal object handed to the pure classifier.
/**
 * #2968: A PULL REQUEST THAT CANNOT MERGE FOR ANY REASON BUT RED HAS AN OWNER SIGNAL.
 *
 * #2950 sat a DRAFT, `DIRTY`, with an EMPTY `statusCheckRollup` for 7.5 hours and no order reached its owner: the
 * conflict order was fed by "not a draft, settled GREEN", and a branch that conflicts gets no `pull_request` run.
 * The class is a state no population could see, so the population here is the CROSS PRODUCT of the domain, not a list
 * of the cases somebody thought of -- the case nobody thought of is what #2950 was.
 *
 * THE EMPTINESS CONTROL: `CELLS.length` is asserted equal to the product of the dimensions' sizes, and every one of
 * the seven reasons is asserted to OCCUR in the population, so "every cell returns one reason" cannot pass on an
 * empty or a one-answer classifier.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stallReasonOf, stallOrderOf, stalledPrOrders, ownerOfPr, STALL_REASON, STALL_REASONS_WITHOUT_A_CAUSE, decide, CAUSES }
  from "../work-gate.mjs";

const REQUIRED = ["gate"];
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const DRAFT = [true, false];
const MERGE_STATES = ["CLEAN", "DIRTY", "BLOCKED", "BEHIND", "UNSTABLE", "UNKNOWN", undefined];
const CHECKS = ["none", "pending", "green", "red"] as const;
const REVIEWS = ["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED", "", undefined];
const HOLDS = [[], ["hold:ceo"]];
const ARMED = [true, false];
const OWNERS = [["session:worker-9"], []];

const ROLLUPS = {
  none: [],
  pending: [{ name: "gate", status: "IN_PROGRESS", conclusion: "" }],
  green: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
  red: [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE" }],
};

type Cell = { pr: Record<string, unknown>; isDraft: boolean; mergeState: string | undefined;
  checks: (typeof CHECKS)[number]; review: string | undefined; held: boolean; armed: boolean; labelled: boolean };

function pr(cell: Omit<Cell, "pr">, n: number): Record<string, unknown> {
  const out: Record<string, unknown> = { number: n, isDraft: cell.isDraft, headRefOid: HEAD, headRefName: `agent/x-${n}`,
    statusCheckRollup: ROLLUPS[cell.checks], armed: cell.armed,
    labels: [...(cell.labelled ? OWNERS[0] : OWNERS[1]), ...(cell.held ? HOLDS[1] : HOLDS[0])].map((name) => ({ name })) };
  // ABSENT MEANS THE KEY IS NOT WRITTEN: `reviewStateOf` keys on `Object.hasOwn`, and `conflictStateOf` on the type.
  if (cell.mergeState !== undefined) out.mergeStateStatus = cell.mergeState;
  if (cell.review !== undefined) out.reviewDecision = cell.review;
  return out;
}

/** The cross product of the dimensions, flattened one dimension at a time so no loop nests past `max-depth`. */
function crossProduct(dimensions: unknown[][]): unknown[][] {
  return dimensions.reduce<unknown[][]>((rows, values) => rows.flatMap((row) => values.map((v) => [...row, v])), [[]]);
}

const CELLS: Cell[] = crossProduct([DRAFT, MERGE_STATES, CHECKS as unknown as unknown[], REVIEWS, HOLDS, ARMED, OWNERS])
  .map(([isDraft, mergeState, checks, review, hold, armed, owner], i) => {
    const cell = { isDraft, mergeState, checks, review, held: (hold as string[]).length > 0, armed, labelled: (owner as string[]).length > 0 } as Omit<Cell, "pr">;
    return { ...cell, pr: pr(cell, i + 1) };
  });

const REASONS: string[] = Object.values(STALL_REASON);
const NOT_STALLS: string[] = [STALL_REASON.PROGRESSING, STALL_REASON.HELD_ON_PURPOSE];
// #3019: `ejected` IS NOT A CELL OF THE CROSS PRODUCT. It is decided by `pr.ejection`, which the gate stamps from a queue-timeline
// read and which none of the seven dimensions above models, so the cells can never reach it. ITS POSITIVE CONTROL IS
// `queue-stalled.test.ts`'s #16 fixture, which classifies a PR as `ejected` and the same PR without the events as `unarmed`.
const REASONS_OF_THE_CELLS: string[] = REASONS.filter((r) => r !== STALL_REASON.EJECTED);

test("#2968 the population is the whole cross product, and it is not empty", () => {
  const size = DRAFT.length * MERGE_STATES.length * CHECKS.length * REVIEWS.length * HOLDS.length * ARMED.length * OWNERS.length;
  assert.equal(size, 2240, "the domain: 2 x 7 x 4 x 5 x 2 x 2 x 2");
  assert.equal(CELLS.length, size, "every cell was built; a loop that skipped one would pass every assertion below");
  assert.equal(STALL_REASON.PROGRESSING, "progressing");
  assert.equal(REASONS.length, 8, "the seven answers #2968 names, and `ejected` (#3019)");
});

test("#2968 EVERY cell returns exactly one reason, and every stall has an order to its owner", () => {
  const seen = new Set<string>();
  for (const { pr: p } of CELLS) {
    const reason = stallReasonOf(p, REQUIRED);
    assert.ok(REASONS.includes(reason), `#${p.number} returned ${JSON.stringify(reason)}, not one of the answers`);
    seen.add(reason);
    const order = stallOrderOf(p, REQUIRED);
    if (NOT_STALLS.includes(reason)) {
      assert.equal(order, null, `#${p.number} is ${reason}, which is not a stall`);
      continue;
    }
    assert.ok(order, `#${p.number} is ${reason} and nobody was told`);
    assert.equal(order.session, ownerOfPr(p).session, `#${p.number} (${reason}) goes to its owner, never to a fallback`);
    assert.ok(CAUSES.includes(order.cause), `${order.cause} is not a declared cause`);
    assert.match(order.prompt, new RegExp(`#${p.number}\\b`), "an order a session is woken with names the pull request");
  }
  assert.deepEqual([...seen].sort(), [...REASONS_OF_THE_CELLS].sort(),
    "THE POSITIVE CONTROL for the loop above: every reason a cell can reach occurs, so no answer is vacuously absent");
});

test("#2968 the reasons follow the domain, cell by cell (an oracle written from the row, not from the code)", () => {
  for (const c of CELLS) {
    const reason = stallReasonOf(c.pr, REQUIRED);
    if (c.held) assert.equal(reason, STALL_REASON.HELD_ON_PURPOSE, "a hold label is somebody's decision");
    else if (c.checks === "red") assert.equal(reason, STALL_REASON.RED, "a red PR is `pr-checks-failing`'s subject, conflicted or not (#2209)");
    else if (c.mergeState === "DIRTY") assert.equal(reason, STALL_REASON.CONFLICTED, "a conflict is code work, whatever CI did");
    else if (c.checks === "none" || c.checks === "pending") assert.equal(reason, STALL_REASON.PROGRESSING, "nothing has settled");
    else if (c.isDraft) assert.equal(reason, STALL_REASON.AWAITING_AUTHOR_DRAFT);
    else if (c.review === "REVIEW_REQUIRED" || c.review === "CHANGES_REQUESTED") assert.equal(reason, STALL_REASON.AWAITING_REVIEW);
    else assert.equal(reason, c.armed ? STALL_REASON.PROGRESSING : STALL_REASON.UNARMED);
  }
});

/** The instance that started it, as the row records it at `244b573aa`. */
const INSTANCE = { number: 2950, isDraft: true, mergeStateStatus: "DIRTY", mergeable: "CONFLICTING", statusCheckRollup: [],
  headRefOid: HEAD, labels: [{ name: "session:worker-2936" }] };

test("#2968 THE INSTANCE: a conflicted DRAFT with no checks is `conflicted` and reaches worker-2936", () => {
  assert.equal(stallReasonOf(INSTANCE, REQUIRED), STALL_REASON.CONFLICTED);
  const order = stallOrderOf(INSTANCE, REQUIRED);
  assert.equal(order?.session, "worker-2936");
  assert.equal(order?.cause, "pr-merge-conflict");
  assert.match(String(order?.prompt), /DRAFT/);
  assert.match(String(order?.prompt), /NO CHECKS/);
  assert.match(String(order?.prompt), /CONFLICTS with `main`/);
});

test("#2968 THE INSTANCE, END TO END: `decide` offers it -- it returned no order at 244b573aa", () => {
  const orders = decide({ prs: [INSTANCE], readyRows: [], required: REQUIRED }) as { session: string, cause: string, causeKey: string }[];
  assert.deepEqual(orders.filter((o) => o.cause === "pr-merge-conflict").map((o) => o.session), ["worker-2936"]);
  assert.equal(orders.find((o) => o.cause === "pr-merge-conflict")?.causeKey,
    `worker-2936/pr-merge-conflict/pr-2950/${HEAD.slice(0, 8)}`, "#2209's key, so an order already delivered is not sent twice");
});

test("#2968 the same pull request UNLABELLED goes to ceo, never product-manager", () => {
  const unlabelled = { ...INSTANCE, labels: [] };
  assert.equal(stallOrderOf(unlabelled, REQUIRED)?.session, "ceo");
  assert.match(String(stallOrderOf(unlabelled, REQUIRED)?.prompt), /NOBODY COULD BE NAMED/);
  assert.deepEqual(stalledPrOrders([unlabelled], { required: REQUIRED }).map((o) => o.session), ["ceo"]);
  const orders = decide({ prs: [unlabelled], readyRows: [], required: REQUIRED }) as { session: string, cause: string }[];
  assert.deepEqual(orders.filter((o) => o.cause === "pr-merge-conflict").map((o) => o.session), ["ceo"]);
});

test("#2968 a held PR is held-on-purpose with NO order; a green, armed, CLEAN PR is progressing", () => {
  const held = { ...INSTANCE, labels: [{ name: "session:worker-2936" }, { name: "hold:ceo" }] };
  assert.equal(stallReasonOf(held, REQUIRED), STALL_REASON.HELD_ON_PURPOSE);
  assert.equal(stallOrderOf(held, REQUIRED), null);
  assert.deepEqual(decide({ prs: [held], readyRows: [], required: REQUIRED }), [], "`hold:ceo` is the freeze that holds THIS row's own PR");
  const evidence = { ...INSTANCE, labels: [{ name: "awaiting-evidence" }] };
  assert.equal(stallReasonOf(evidence, REQUIRED), STALL_REASON.HELD_ON_PURPOSE);
  const clean = { number: 1, isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", armed: true,
    statusCheckRollup: ROLLUPS.green, labels: [{ name: "session:worker-1" }] };
  assert.equal(stallReasonOf(clean, REQUIRED), STALL_REASON.PROGRESSING);
  assert.equal(stallOrderOf(clean, REQUIRED), null);
});

test("#2968 an UNREAD arming or review decision is never an accusation", () => {
  const green = { number: 3, isDraft: false, mergeStateStatus: "CLEAN", statusCheckRollup: ROLLUPS.green, labels: [] };
  assert.equal(stallReasonOf(green, REQUIRED), STALL_REASON.PROGRESSING, "no `armed`, no `reviewDecision`: the gate did not ask");
  assert.equal(stallReasonOf({ ...green, armed: false }, REQUIRED), STALL_REASON.UNARMED);
});

test("#2968 `decide` sends only the reason that has no cause of its own, so no session is woken twice for one fact", () => {
  assert.deepEqual([...STALL_REASONS_WITHOUT_A_CAUSE], [STALL_REASON.CONFLICTED, STALL_REASON.EJECTED]);
  const red = { number: 4, isDraft: false, headRefOid: HEAD, mergeStateStatus: "BLOCKED", statusCheckRollup: ROLLUPS.red, labels: [{ name: "session:worker-4" }] };
  const orders = decide({ prs: [red], readyRows: [], required: REQUIRED }) as { cause: string }[];
  assert.deepEqual(orders.map((o) => o.cause), ["pr-checks-failing"], "the red order is the existing one, once");
});
