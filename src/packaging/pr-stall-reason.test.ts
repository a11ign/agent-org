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
import { stallReasonOf, stallOrderOf, stalledPrOrders, ownerOfPr, STALL_REASON, STALL_REASONS_WITHOUT_A_CAUSE, decide, CAUSES, stalledPrFacts }
  from "../work-gate.ts";
import { hungCheckOf, CHECK_RUNNING_TOO_LONG_MINUTES } from "../work-gate/pr-orders.mjs";

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
// #3120: `hung-check` IS NOT A CELL EITHER: no cell's rollup carries a `startedAt`, so none can be aged. ITS POSITIVE CONTROL IS THE
// `#83` test at the foot of this file, which asserts the shape occurs and is classified `hung-check`.
const REASONS_OF_THE_CELLS: string[] = REASONS.filter((r) => r !== STALL_REASON.EJECTED && r !== STALL_REASON.HUNG_CHECK);

test("#2968 the population is the whole cross product, and it is not empty", () => {
  const size = DRAFT.length * MERGE_STATES.length * CHECKS.length * REVIEWS.length * HOLDS.length * ARMED.length * OWNERS.length;
  assert.equal(size, 2240, "the domain: 2 x 7 x 4 x 5 x 2 x 2 x 2");
  assert.equal(CELLS.length, size, "every cell was built; a loop that skipped one would pass every assertion below");
  assert.equal(STALL_REASON.PROGRESSING, "progressing");
  assert.equal(REASONS.length, 9, "the seven answers #2968 names, `ejected` (#3019) and `hung-check` (#3120)");
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
  assert.deepEqual([...STALL_REASONS_WITHOUT_A_CAUSE], [STALL_REASON.CONFLICTED, STALL_REASON.EJECTED, STALL_REASON.HUNG_CHECK]);
  const red = { number: 4, isDraft: false, headRefOid: HEAD, mergeStateStatus: "BLOCKED", statusCheckRollup: ROLLUPS.red, labels: [{ name: "session:worker-4" }] };
  const orders = decide({ prs: [red], readyRows: [], required: REQUIRED }) as { cause: string }[];
  assert.deepEqual(orders.map((o) => o.cause), ["pr-checks-failing"], "the red order is the existing one, once");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// #3120: A CHECK THAT HAS RUN FOR HOURS ON A NON-DRAFT PULL REQUEST HELD FOR REVIEW IS NOT `progressing` (a11ign/agent-org#83 sat 4 h).
// Every `now` here is an ARGUMENT: the classifier is pure, so no case depends on the wall clock.
// ---------------------------------------------------------------------------------------------------------------------------------
const STARTED = "2026-10-03T01:14:06Z";
const AT = (iso: string) => Date.parse(iso);
const HUNG_NOW = AT("2026-10-03T05:15:00Z");
const gate = (over: Record<string, unknown> = {}) => ({ name: "gate", status: "IN_PROGRESS", conclusion: "", startedAt: STARTED,
  detailsUrl: "https://github.com/a11ign/agent-org/actions/runs/37085299585/job/1", ...over });
const arm = { name: "arm", status: "COMPLETED", conclusion: "SUCCESS", startedAt: STARTED };
/** #83's shape: non-draft, no labels, `REVIEW_REQUIRED`, `gate` still running, `arm` settled. */
const PR_83 = { number: 83, isDraft: false, reviewDecision: "REVIEW_REQUIRED", headRefOid: HEAD, labels: [], statusCheckRollup: [gate(), arm] };

type Order = { session: string, cause: string, prompt: string, causeKey: string };
const orders = (prs: Record<string, unknown>[], nowMs: number) => decide({ prs, readyRows: [], required: REQUIRED, nowMs }) as Order[];

test("#3120 (5a, POSITIVE) #83's shape is `hung-check` and its owner is told -- and the case occurs in its own population", () => {
  const population = [PR_83];
  assert.equal(population.filter((p) => stallReasonOf(p, REQUIRED, HUNG_NOW) === STALL_REASON.HUNG_CHECK).length, 1, "the case occurs, so the negatives below cannot pass on an empty population");
  assert.equal(stallReasonOf(PR_83, REQUIRED, HUNG_NOW), "hung-check");
  assert.equal(stallReasonOf(PR_83, null, HUNG_NOW), "hung-check", "with the required list unread, every check blocks: the same answer");
  const told = orders([PR_83], HUNG_NOW).filter((o) => o.causeKey.includes("hung-check"));
  assert.equal(told.length, 1);
  assert.equal(told[0].session, ownerOfPr(PR_83).session, "an unowned PR goes to ceo, as #2968 rules for every stall");
  assert.equal(told[0].session, "ceo");
  const owned = orders([{ ...PR_83, labels: [{ name: "session:worker-83" }] }], HUNG_NOW).filter((o) => o.causeKey.includes("hung-check"));
  assert.deepEqual(owned.map((o) => o.session), ["worker-83"]);
});

test("#3120 (2) the order names the PR, the check, how long it has run and the run it is", () => {
  const prompt = String(stallOrderOf(PR_83, REQUIRED, HUNG_NOW)?.prompt);
  assert.match(prompt, /#83\b/);
  assert.match(prompt, /`gate`/);
  assert.match(prompt, /running for 240 minutes/, "01:14:06 to 05:15:00 is 240 min 54 s, floored");
  assert.match(prompt, /actions\/runs\/37085299585/, "the run, as a link the engineer opens");
  const noLink = String(stallOrderOf({ ...PR_83, statusCheckRollup: [gate({ detailsUrl: undefined }), arm] }, REQUIRED, HUNG_NOW)?.prompt);
  assert.match(noLink, /NOT in the check rollup/, "a link the read did not carry is said to be missing, not guessed");
});

test("#3120 (5b, NEGATIVE) ten minutes in is still `progressing` with no order; and the threshold is exact", () => {
  assert.equal(CHECK_RUNNING_TOO_LONG_MINUTES, 60, "measured: longest `ci` run in either repo was 12 min (see the constant)");
  const early = AT(STARTED) + 10 * 60_000;
  assert.equal(stallReasonOf(PR_83, REQUIRED, early), STALL_REASON.PROGRESSING);
  assert.equal(stallOrderOf(PR_83, REQUIRED, early), null);
  assert.equal(orders([PR_83], early).filter((o) => o.causeKey.includes("pr-83")).length, 0);
  const limit = AT(STARTED) + CHECK_RUNNING_TOO_LONG_MINUTES * 60_000;
  assert.equal(stallReasonOf(PR_83, REQUIRED, limit), STALL_REASON.PROGRESSING, "AT the limit is not past it");
  assert.equal(stallReasonOf(PR_83, REQUIRED, limit + 1), STALL_REASON.HUNG_CHECK, "one millisecond past it is");
});

test("#3120 (5c, NEGATIVE) the same check COMPLETED is not hung, whatever it concluded or however long ago it started", () => {
  assert.equal(stallReasonOf({ ...PR_83, statusCheckRollup: [gate({ status: "COMPLETED", conclusion: "SUCCESS" }), arm] }, REQUIRED, HUNG_NOW), STALL_REASON.AWAITING_REVIEW,
    "settled green on a REVIEW_REQUIRED PR is `awaiting-review`, its own cause's subject");
  assert.equal(stallReasonOf({ ...PR_83, statusCheckRollup: [gate({ status: "COMPLETED", conclusion: "FAILURE" }), arm] }, REQUIRED, HUNG_NOW), STALL_REASON.RED);
});

test("#3120 (5d, NEGATIVE) an older, superseded run of the same name still running beside a newer settled one does not count", () => {
  const newer = gate({ status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-03T05:00:00Z", completedAt: "2026-10-03T05:03:00Z" });
  const pr = { ...PR_83, reviewDecision: "APPROVED", armed: true, statusCheckRollup: [gate(), newer, arm] };
  assert.equal(hungCheckOf(pr, REQUIRED, HUNG_NOW), null);
  assert.equal(stallReasonOf(pr, REQUIRED, HUNG_NOW), STALL_REASON.PROGRESSING);
});

test("#3120 (5e, NEGATIVE) a DRAFT with the same hung check, and a held or awaiting-evidence PR, get no order", () => {
  const draft = { ...PR_83, isDraft: true };
  assert.equal(stallReasonOf(draft, REQUIRED, HUNG_NOW), STALL_REASON.PROGRESSING, "a hung check on a draft is its author's work in progress");
  assert.equal(stallOrderOf(draft, REQUIRED, HUNG_NOW), null);
  for (const label of ["hold:ceo", "awaiting-evidence"]) {
    const held = { ...PR_83, labels: [{ name: label }] };
    assert.equal(stallReasonOf(held, REQUIRED, HUNG_NOW), STALL_REASON.HELD_ON_PURPOSE, label);
    assert.equal(stallOrderOf(held, REQUIRED, HUNG_NOW), null, label);
  }
});

test("#3120 a check with no readable `startedAt`, or a NON-blocking one, is never accused", () => {
  for (const startedAt of [undefined, "", "not a date"]) {
    assert.equal(stallReasonOf({ ...PR_83, statusCheckRollup: [gate({ startedAt }), arm] }, REQUIRED, HUNG_NOW), STALL_REASON.PROGRESSING, `startedAt ${JSON.stringify(startedAt)}: absent is not an age`);
  }
  const optional = { ...PR_83, statusCheckRollup: [gate({ name: "lint-extra" }), { ...arm, name: "gate" }] };
  assert.equal(stallReasonOf(optional, REQUIRED, HUNG_NOW), STALL_REASON.AWAITING_REVIEW, "only a required check can hold the PR, so only one is aged");
  assert.equal(stallReasonOf({ ...PR_83, statusCheckRollup: [gate({ status: "QUEUED" }), arm] }, REQUIRED, HUNG_NOW), STALL_REASON.HUNG_CHECK, "queued for an hour is as stuck as running");
});

test("#3120 (3) a RE-RUN fires again; the same hang on a later tick does not", () => {
  const key = (pr: Record<string, unknown>, nowMs: number) => stallOrderOf(pr, REQUIRED, nowMs)?.causeKey;
  const first = key(PR_83, HUNG_NOW);
  assert.ok(first?.endsWith(`/hung-check/${STARTED}`), String(first));
  assert.equal(key(PR_83, HUNG_NOW + 30 * 60_000), first, "same hang, a later tick: same key, so no repeat while nothing changed");
  const rerun = { ...PR_83, statusCheckRollup: [gate({ startedAt: "2026-10-03T05:15:04Z" }), arm] };
  assert.equal(key(rerun, AT("2026-10-03T06:30:00Z")), first?.replace(STARTED, "2026-10-03T05:15:04Z"), "the same head hanging a second time is a NEW key");
  assert.notEqual(key(rerun, AT("2026-10-03T06:30:00Z")), first);
});

test("#3120 (4) the hung PR is read from the tick's own facts, and the order is filed under an existing declared cause", () => {
  // `stalledPrFacts` takes `{ now }` and nothing else (#3486 made the age free), so it has no seam through which to call `gh`; this once recorded the calls and asserted none, which
  // could no longer fail. The PR is hung, so the case is in the population and not an empty one.
  const recent = { ...PR_83, createdAt: new Date(HUNG_NOW - 60_000).toISOString() };
  const facts = stalledPrFacts([recent], REQUIRED, { now: HUNG_NOW });
  assert.deepEqual(facts.map((f: { reason: string }) => f.reason), [STALL_REASON.HUNG_CHECK]);
  const order = stallOrderOf(PR_83, REQUIRED, HUNG_NOW);
  assert.ok(order && CAUSES.includes(order.cause), "no new cause is declared");
  assert.equal(order.cause, "pr-checks-failing");
});

test("#3120 (5f) the green, armed, clean PR is still `progressing`, and a PR whose CI never started stays `progressing` too", () => {
  const clean = { number: 1, isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", armed: true, statusCheckRollup: ROLLUPS.green, labels: [{ name: "session:worker-1" }] };
  assert.equal(stallReasonOf(clean, REQUIRED, HUNG_NOW), STALL_REASON.PROGRESSING);
  assert.equal(stallReasonOf({ ...clean, statusCheckRollup: [] }, REQUIRED, HUNG_NOW), STALL_REASON.PROGRESSING, "no check, no `startedAt` to age: not this reason's");
});
