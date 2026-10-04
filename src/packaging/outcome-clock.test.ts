// no-token: gh -- pure: the clock is a function of facts handed in, and the one process test puts a stub `gh` on PATH under a scratch HOME; nothing here reaches the real one
/**
 * THE OUTCOME CLOCK (#3486, the chairman's "how do we make sure nothing happens again?", 2026-10-04): `overdueReading` in `org-health.mjs` and its facts in
 * `work-gate/org-health.mjs`. EVERY OPEN PR AND EVERY CLAIMED ROW HAS AN AGE SINCE IT OPENED; ONLY A MERGE OR A CLOSE STOPS IT; NO STATE EXEMPTS IT.
 *
 * THE BOUNDS ARE WRITTEN OUT AS 100 AND 135 MINUTES HERE, NEVER AS THE EXPORTED CONSTANTS, for the reason `org-health.test.ts` gives for its own: a test
 * built from the constant moves with it. `the bounds are the measurement's` pins the literals to the exports in ONE place, with the measurement beside them.
 *
 * SLICE 2b (the two CLAIMED-ROW shapes of `ceo`'s 19:47Z fixture): (5) #3131, a claimed row whose holder sits idle on a `Not-before` that is in the past, and (6) #3495,
 * a claim that never started. They are named by the REAL idle reading (`idleClaimantReading`) over the REAL claim moves, a herdr listing that is idle, and the row's own
 * fields. THE ROW BOUND IS STILL 135 MINUTES: the shapes' own, shorter bound (`OVERDUE_IDLE_CLAIM_MINUTES`, 80) is not read by `boundOf`, which lives in a file
 * this slice does not declare, so a shape is NAMED on the row the 135-minute clock raises and `#3495 AT 100 MINUTES` IS NOT RAISED (a test below says so).
 *
 * EVERY NEW SHAPE BECOMES A FIXTURE HERE (done-when 2c of #3486): the five shapes the chairman found by hand on 2026-10-04 are in `SHAPES` (the fifth, Dependabot #3472, is the one with no gate order at all), each built through
 * the REAL classifier (`stallReasonOf`) and the REAL fact readers, so a fixture is the state the gate sees and not a hand-written `reason`. A fifth shape is one
 * more entry in `SHAPES`; the two tests over it (`raised at the bound`, `not raised one millisecond under`) then cover it with no further code.
 *
 * THE POSITIVE CONTROL OF EVERY "is not overdue" BELOW IS THE SAME FIXTURE ONE MILLISECOND OLDER: the shape is only worth being called clear because the same
 * state, aged by that millisecond, trips, through the same entry (`orgHealthTick`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, cpSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.mjs";

// The project this file runs against is the recorded one `org-health.test.ts` explains (#3233): the host file is set FIRST and the tool imported AFTER it.
const PROJECT_SCRATCH = mkdtempSync(join(tmpdir(), "outcome-clock-project-"));
after(() => rmSync(PROJECT_SCRATCH, { recursive: true, force: true }));
const PROJECT = join(PROJECT_SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(PROJECT_SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: PROJECT_SCRATCH, binDir: join(PROJECT_SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(PROJECT_SCRATCH, "workers"), leads: join(PROJECT_SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

const orgHealth = await import("../org-health.mjs");
const { OVERDUE_PR_MINUTES, OVERDUE_ROW_MINUTES, SIGNALS, overdueReading, orgHealthTick } = orgHealth;
const { stallReasonOf, STALL_REASON } = await import("../work-gate.mjs");
const { overdueFacts, claimedRowFacts, orgHealthNow, needsHolderAgents, OVERDUE_IDLE_CLAIM_MINUTES, IDLE_CLAIM_REASON } = await import("../work-gate/org-health.mjs");
const { claimRecordComment } = await import("../row-claim.mjs");

const GATE_ENTRY = fileURLToPath(new URL("../work-gate.mjs", import.meta.url));
const STUB_MODE = 0o755;
const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-10-04T16:00:00Z");
const PR_BOUND_MS = 100 * MINUTE_MS;
const ROW_BOUND_MS = 135 * MINUTE_MS;

const REQUIRED = ["gate"];
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }];
const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE" }];
const iso = (ms: number) => new Date(ms).toISOString();
const label = (...names: string[]) => names.map((name) => ({ name }));
const BOT = { login: "a11ign-ai-workers" };

type Moves = import("../work-gate/claim-stall-tick.mjs").ClaimMoves;
type HoldersIn = { moves: Map<number, Moves> | null; agents: { label: string; status: string }[] | null };
type Order = { session: string; cause: string; subject: string; discriminator: string; prompt: string };
type Items = ReturnType<typeof overdueFacts>["items"];

/** The facts every other signal reads, every one CLEAR, so a test names only the clock. */
const quiet = (over: Record<string, unknown> = {}) => ({ now: NOW, lastMergedAt: NOW - 60 * MINUTE_MS, work: { greenPrs: 1, claimableRows: 0 }, redPrs: [],
  refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] as string[] }, primarySince: null, ...over });

/** What the gate hands the tick for these PRs and rows, through the real classifier and fact readers, and what the tick OFFERS for the clock. */
function clock({ prs = [], rows = [], comments = [], holders }: { prs?: Record<string, unknown>[]; rows?: Record<string, unknown>[]; comments?: Record<string, unknown>[];
  holders?: HoldersIn }) {
  const facts = overdueFacts({ prsRead: prs, openRowsRead: rows, claimedComments: comments, required: REQUIRED, now: NOW,
    ...(holders === undefined ? {} : { holders: { ...holders, now: NOW } as never }) });
  const orders = orgHealthTick(quiet({ overdue: facts }) as never, { log: () => undefined }) as Order[];
  return { facts, orders: orders.filter((o) => o.subject === SIGNALS.OVERDUE) };
}

/** A claim record as the REAL writer words it (`row-claim.mjs`'s `claimRecordComment`), so the reader is tested against the writer and not a copy of it. */
const claimComment = (session: string, at: number) => ({ body: claimRecordComment({ session, branch: `agent/x-${session}`, worktree: `../wt-${session}`, nothing: null }),
  createdAt: iso(at), author: BOT });

// --- THE FOUR SHAPES OF 2026-10-04, each a state the classifier gives a name and the old net could not see ---------------------------------------

const base = { isDraft: false, statusCheckRollup: GREEN, headRefOid: HEAD, labels: label("session:worker-9"), reviews: [] as unknown[] };
type Shape = { name: string; boundMs: number; reason: string; kind: "pr" | "row";
  at: (ageMs: number) => { prs?: Record<string, unknown>[]; rows?: Record<string, unknown>[]; comments?: Record<string, unknown>[]; holders?: HoldersIn } };

// --- who holds a claimed row: the claim-stall tick's moves and herdr's own listing, as the gate hands them to the clock ----------------------------------------
const STANDING = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }];
const listing = (worker: string, status: string) => [...STANDING, { label: worker, status }];
const NOTHING_DONE = (claimedAt: number): Moves => ({ claimedAt, comment: null, commit: null, push: null, openPrs: [], mergedAt: null });
/** A claimed row of `number`, held by `worker-<number>`, claimed `age` ago, its `status` in herdr and its `moves` over the untouched ones. */
function heldRow(number: number, age: number, { status = "idle", body = "", moves = {} }: { status?: string; body?: string; moves?: Partial<Moves> } = {}) {
  const claimedAt = NOW - age;
  return { rows: [{ number, body, labels: label("in-progress", `session:worker-${number}`) }], comments: [{ number, comments: [claimComment(`worker-${number}`, claimedAt)] }],
    holders: { moves: new Map([[number, { ...NOTHING_DONE(claimedAt), ...moves }]]), agents: listing(`worker-${number}`, status) } };
}
const PAST_NOT_BEFORE = "## When\nNot-before: 2026-10-04T10:00:00Z\n";
const FUTURE_NOT_BEFORE = "## When\nNot-before: 2026-10-04T20:00:00Z\n";

const SHAPES: Shape[] = [
  { name: "#3406: an APPROVED DRAFT with no stamp, which nobody was told to mark ready (about 2 h 15 min)", boundMs: PR_BOUND_MS, kind: "pr", reason: STALL_REASON.AWAITING_AUTHOR_DRAFT,
    at: (age) => ({ prs: [{ ...base, number: 3406, isDraft: true, reviewDecision: "APPROVED", createdAt: iso(NOW - age), comments: [] }] }) },
  { name: "#3460: a test pinned to main's hashes, EJECTED by the queue and RE-QUEUED by auto-arm, the bot commenting every few minutes", boundMs: PR_BOUND_MS, kind: "pr",
    reason: STALL_REASON.EJECTED,
    at: (age) => ({ prs: [{ ...base, number: 3460, armed: false, ejection: { removedAt: iso(NOW - 5 * MINUTE_MS), runId: 1, failingTests: ["pinned-to-main-hashes.test.ts"] },
      createdAt: iso(NOW - age), comments: [{ createdAt: iso(NOW - MINUTE_MS), author: BOT }] }] }) },
  { name: "agent-org #149: a cross-repo hold whose condition came true, 40 minutes of it, the hold itself the last thing anyone touched", boundMs: PR_BOUND_MS, kind: "pr",
    reason: STALL_REASON.HELD_ON_PURPOSE,
    at: (age) => ({ prs: [{ ...base, number: 149, labels: label("session:worker-149", "hold:ceo"), createdAt: iso(NOW - age),
      comments: [{ createdAt: iso(NOW - MINUTE_MS), author: BOT }] }] }) },
  { name: "#3465: the stall alarm itself deferred behind a busy ceo -- the clock sees the ROW waiting on it, the claimant commenting all the while", boundMs: ROW_BOUND_MS,
    kind: "row", reason: "claimed",
    at: (age) => ({ rows: [{ number: 3465, labels: label("in-progress", "session:worker-3465") }],
      comments: [{ number: 3465, comments: [claimComment("worker-3465", NOW - age), { body: "still on it", createdAt: iso(NOW - MINUTE_MS), author: BOT }] }] }) },
  { name: "#3472: a DEPENDABOT PR, approved, clean, ready and UNARMED for 1.5 h with no gate order of any kind -- a bot author is in the population like any other",
    boundMs: PR_BOUND_MS, kind: "pr", reason: STALL_REASON.UNARMED,
    at: (age) => ({ prs: [{ ...base, number: 3472, labels: [], author: { login: "app/dependabot", is_bot: true }, headRefName: "dependabot/npm_and_yarn/x-1.2.3",
      reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", armed: false, createdAt: iso(NOW - age), comments: [] }] }) },
  { name: "#3131: a claimed row, no pull request, its worker IDLE on a `Not-before` that is in the PAST (it waited for a rebuild that never ran, 17 h)", boundMs: ROW_BOUND_MS,
    kind: "row", reason: IDLE_CLAIM_REASON.WAIT_PREMISE_GONE,
    at: (age) => heldRow(3131, age, { body: PAST_NOT_BEFORE, moves: { comment: NOW - age + 10 * MINUTE_MS } }) },
  { name: "#3495: a claim that NEVER STARTED -- no commit, no push, no comment, no pull request, its worker idle", boundMs: ROW_BOUND_MS, kind: "row",
    reason: IDLE_CLAIM_REASON.NEVER_STARTED, at: (age) => heldRow(3495, age) },
];

test("the bounds are the measurement's: 100 min for a PR (3 x 33.7) and 135 min for a claimed row (3 x 44.5), and the 180-minute net is GONE", () => {
  assert.equal(OVERDUE_PR_MINUTES, 100, "3 x the 33.7 min median of 289 a11ign/a11ign PRs merged 2026-09-27..10-04; the measurement is beside the constant");
  assert.equal(OVERDUE_ROW_MINUTES, 135, "3 x the 44.5 min median of 282 rows closed 2026-10-01..10-04, newest claim record to close");
  assert.equal(SIGNALS.OVERDUE, "overdue");
  assert.equal("PR_NOT_PROGRESSING_MINUTES" in orgHealth, false, "done-when 5: the 180-minute constant is deleted, not left beside the clock");
  assert.equal("REASONS_THAT_ARE_NOT_A_STALL" in orgHealth, false, "done-when 5: the exemption is deleted, not left beside the clock");
});

for (const shape of SHAPES) {
  test(`RAISED AT THE BOUND: ${shape.name}`, () => {
    const { facts, orders } = clock(shape.at(shape.boundMs));
    const item = (facts.items as NonNullable<Items>).find((i) => i.kind === shape.kind);
    assert.equal(item?.reason, shape.reason, "the fixture really is the shape: the gate's own label for it, from the real classifier");
    assert.equal(orders.length, 1, "overdue at EXACTLY the bound, whatever the state");
    assert.equal(orders[0].session, "ceo");
    assert.equal(orders[0].cause, "org-health");
    assert.match(orders[0].prompt, new RegExp(`#${item?.number} \\(${shape.kind === "pr" ? "PR" : "row"}, ${shape.reason}, open `));
  });

  test(`NOT RAISED ONE MILLISECOND UNDER THE BOUND (the control): ${shape.name}`, () => {
    assert.deepEqual(clock(shape.at(shape.boundMs - 1)).orders, []);
    assert.equal(clock(shape.at(shape.boundMs)).orders.length, 1, "POSITIVE CONTROL: the same state a millisecond older trips");
  });
}

test("THE SEVEN SHAPES ARE THE SET: a PR shape and a row shape are both here, and an emptiness above would be caught by this count", () => {
  assert.equal(SHAPES.length, 7);
  assert.deepEqual(SHAPES.map((s) => s.kind).sort(), ["pr", "pr", "pr", "pr", "row", "row", "row"]);
  assert.deepEqual(SHAPES.filter((s) => s.kind === "row").map((s) => s.reason).sort(), ["claimed", IDLE_CLAIM_REASON.NEVER_STARTED, IDLE_CLAIM_REASON.WAIT_PREMISE_GONE].sort());
});

// --- the two claimed-row shapes of slice 2b, and the controls that make them mean something ---------------------------------------------------------------

/** The reason the clock gives the one row in these facts, and whether the tick offers an order for it. */
function rowReading(args: Parameters<typeof clock>[0]) {
  const { facts, orders } = clock(args);
  return { reason: (facts.items as NonNullable<Items>).find((i) => i.kind === "row")?.reason, raised: orders.length, unread: facts.unread };
}

test("THE MEASURED IDLE BOUND is 80 minutes (p95 77.0 of claim-to-first-commit, plus one tick), BELOW the 135-minute row bound", () => {
  assert.equal(OVERDUE_IDLE_CLAIM_MINUTES, 80, "77.0 min is the p95 of 33 rows' claim to first commit; the measurement is beside the constant");
  assert.ok(OVERDUE_IDLE_CLAIM_MINUTES < OVERDUE_ROW_MINUTES);
});

test("CONTROL: the same row with the worker BUSY is not named for the shape, at the idle bound or at the row bound (where the clock still raises it as `claimed`)", () => {
  const busy = (age: number) => heldRow(3131, age, { status: "working", body: PAST_NOT_BEFORE, moves: { comment: NOW - age + 10 * MINUTE_MS } });
  assert.deepEqual(rowReading(busy(100 * MINUTE_MS)), { reason: "claimed", raised: 0, unread: [] });
  assert.deepEqual(rowReading(busy(ROW_BOUND_MS)), { reason: "claimed", raised: 1, unread: [] }, "the clock has no exemption: a busy row is still raised at 135, labelled `claimed`");
  assert.equal(rowReading(heldRow(3131, ROW_BOUND_MS, { body: PAST_NOT_BEFORE, moves: { comment: NOW - ROW_BOUND_MS + 10 * MINUTE_MS } })).reason, IDLE_CLAIM_REASON.WAIT_PREMISE_GONE,
    "POSITIVE CONTROL: the same row, idle, is named");
});

test("CONTROL: a `Not-before` still in the FUTURE with the worker idle is a wait that holds -- not named, and not raised under the row bound", () => {
  const waiting = (age: number) => heldRow(3131, age, { body: FUTURE_NOT_BEFORE });
  assert.deepEqual(rowReading(waiting(100 * MINUTE_MS)), { reason: "claimed", raised: 0, unread: [] });
  assert.equal(rowReading(waiting(ROW_BOUND_MS)).reason, "claimed");
  assert.equal(rowReading(heldRow(3131, 100 * MINUTE_MS, { body: PAST_NOT_BEFORE })).reason, IDLE_CLAIM_REASON.WAIT_PREMISE_GONE, "POSITIVE CONTROL: the same row with the field in the past");
});

test("CONTROL: a REFUSED or PARTIAL herdr listing is reported UNREAD and names nothing -- the reading is unknown, never clear and never a trip", () => {
  const at = 100 * MINUTE_MS;
  for (const [what, agents] of [["refused", null], ["partial (no standing pane)", [{ label: "worker-3495", status: "idle" }]]] as const) {
    const held = { ...heldRow(3495, at), holders: { ...heldRow(3495, at).holders, agents: agents as HoldersIn["agents"] } };
    const reading = rowReading(held);
    assert.deepEqual(reading, { reason: "claimed", raised: 0, unread: ["the herdr listing"] }, what);
    const facts = overdueFacts({ prsRead: [], openRowsRead: held.rows, claimedComments: held.comments, required: REQUIRED, now: NOW, holders: { ...held.holders, now: NOW } as never });
    assert.equal(overdueReading({ now: NOW, ...facts }).status, "unknown", `${what}: unknown`);
  }
  const idle = heldRow(3495, at);
  const facts = overdueFacts({ prsRead: [], openRowsRead: idle.rows, claimedComments: idle.comments, required: REQUIRED, now: NOW, holders: { ...idle.holders, now: NOW } as never });
  assert.equal(overdueReading({ now: NOW, ...facts }).status, "clear", "POSITIVE CONTROL: the same row with a whole listing is read, and is clear under the row bound");
  assert.equal(rowReading(idle).reason, IDLE_CLAIM_REASON.NEVER_STARTED);
});

test("A claim-stall tick that read NO claim is reported unread, and a caller that passes no holders is silent (the rows are `claimed`/`held` only)", () => {
  const held = heldRow(3495, 100 * MINUTE_MS);
  const unread = clock({ ...held, holders: { moves: null, agents: null } }).facts;
  assert.deepEqual(unread.unread, ["the claim-stall tick's reading of the claimed rows"]);
  assert.deepEqual(clock({ rows: held.rows, comments: held.comments }).facts.unread, []);
});

test("NOT NAMED: a row that has MOVED (a commit, or a comment) is not `never-started`; one owning a pull request is the PR's clock; one younger than the idle bound is left alone", () => {
  const age = 100 * MINUTE_MS;
  assert.equal(rowReading(heldRow(1, age, { moves: { commit: NOW - 90 * MINUTE_MS } })).reason, "claimed", "a commit is a move");
  assert.equal(rowReading(heldRow(2, age, { moves: { comment: NOW - 90 * MINUTE_MS } })).reason, "claimed", "a comment is a move");
  assert.equal(rowReading(heldRow(3, age, { moves: { openPrs: [{ createdAt: iso(NOW - 30 * MINUTE_MS), labels: [] }] } })).reason, "claimed", "a pull request owns the clock");
  assert.equal(rowReading(heldRow(4, age, { moves: { mergedAt: NOW - MINUTE_MS } })).reason, "claimed", "a merged one is the merge's");
  assert.equal(rowReading(heldRow(5, (OVERDUE_IDLE_CLAIM_MINUTES - 1) * MINUTE_MS)).reason, "claimed", "under the idle bound a holder between two turns is not named");
  assert.equal(rowReading(heldRow(6, OVERDUE_IDLE_CLAIM_MINUTES * MINUTE_MS)).reason, IDLE_CLAIM_REASON.NEVER_STARTED, "POSITIVE CONTROL: at the idle bound it is");
});

test("A HOLD NAMES NOTHING NEW WHEN NOBODY IS IDLE, and a hold on an idle claim that never started is still named for the shape (the reason is a label, the hold excuses nothing)", () => {
  const held = heldRow(3495, ROW_BOUND_MS);
  const withHold = { ...held, rows: [{ ...held.rows[0], labels: label("in-progress", "session:worker-3495", "hold:ceo") }] };
  assert.equal(rowReading(withHold).reason, IDLE_CLAIM_REASON.NEVER_STARTED);
  assert.equal(rowReading(withHold).raised, 1);
});

test("TODAY #3495'S 100 MINUTES IS NAMED BUT NOT RAISED: the shape is below the 135-minute row bound and `boundOf` reads one bound per kind (the follow-up reads a per-item one)", () => {
  const reading = rowReading(SHAPES[6].at(100 * MINUTE_MS) as ReturnType<typeof heldRow>);
  assert.deepEqual(reading, { reason: IDLE_CLAIM_REASON.NEVER_STARTED, raised: 0, unread: [] });
});

// --- the tick hands the clock whom the rows are held by, and pays for herdr only when a row needs it -----------------------------------------------------

function wired({ rows, comments, claimFacts, agents }: { rows: Record<string, unknown>[]; comments: Record<string, unknown>[]; claimFacts: unknown; agents: HoldersIn["agents"] }) {
  const asked: string[] = [];
  const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [], claimFacts };
  const orders = orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: rows, claimedComments: comments, decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => NOW - 60 * MINUTE_MS, log: () => undefined, readCopies: (() => []) as never, readCaptures: (() => undefined) as never,
      readWaits: (() => null) as never, release: (() => false) as never, readHolderAgents: (() => { asked.push("herdr"); return agents; }) as never });
  return { orders: (orders as Order[]).filter((o) => o.subject === SIGNALS.OVERDUE), asked };
}

test("THE TICK: `orgHealthNow` reads the claim-stall tick's moves from `decideArgs.claimFacts` and herdr's listing ONLY for a row in question, and names #3495 at the row bound", () => {
  const held = heldRow(3495, ROW_BOUND_MS);
  const claimFacts = { moves: held.holders.moves, skipped: new Map() };
  const raised = wired({ rows: held.rows, comments: held.comments, claimFacts, agents: held.holders.agents });
  assert.equal(raised.orders.length, 1);
  assert.match(raised.orders[0].prompt, /#3495 \(row, never-started, open 2\.3 h, owner worker-3495\)/);
  assert.equal(raised.asked.length, 1, "one listing");
  const young = heldRow(3495, 10 * MINUTE_MS);
  const quiet = wired({ rows: young.rows, comments: young.comments, claimFacts: { moves: young.holders.moves, skipped: new Map() }, agents: young.holders.agents });
  assert.deepEqual([quiet.orders, quiet.asked], [[], []], "a claim that moved inside the bound makes no herdr call");
  const notAsked = wired({ rows: held.rows, comments: held.comments, claimFacts: undefined, agents: held.holders.agents });
  assert.deepEqual([notAsked.asked, (notAsked.orders[0].prompt.match(/#3495 \(row, ([a-z-]+),/) ?? [])[1]], [[], "claimed"], "a caller that offers no claim facts is not asked about holders");
});

test("`needsHolderAgents` is false for no claimed row, a moving one and a PR-owned one, and true for an untouched one past the idle bound", () => {
  const held = heldRow(3495, 100 * MINUTE_MS);
  assert.equal(needsHolderAgents(held.rows, held.holders.moves, NOW), true);
  assert.equal(needsHolderAgents([{ number: 1, labels: label("ready") }], held.holders.moves, NOW), false);
  assert.equal(needsHolderAgents(held.rows, null, NOW), false);
  assert.equal(needsHolderAgents(held.rows, heldRow(3495, 100 * MINUTE_MS, { moves: { openPrs: [{}] } }).holders.moves, NOW), false);
});

// --- nothing restarts the clock, and nothing excuses an item ---------------------------------------------------------------------------------

test("a comment, a review, a label and a hold do NOT restart the clock: the same overdue PR with all four in the last minute is still overdue", () => {
  const stuck = { ...base, number: 1, createdAt: iso(NOW - PR_BOUND_MS), comments: [], reviews: [] as unknown[] };
  assert.equal(clock({ prs: [stuck] }).orders.length, 1, "POSITIVE CONTROL: the bare PR is overdue");
  const touched = { ...stuck, labels: label("session:worker-9", "hold:ceo", "awaiting-evidence"), comments: [{ createdAt: iso(NOW - MINUTE_MS), author: BOT }],
    reviews: [{ submittedAt: iso(NOW - MINUTE_MS) }], updatedAt: iso(NOW - MINUTE_MS) };
  assert.equal(clock({ prs: [touched] }).orders.length, 1);
});

test("NO STATE EXEMPTS: every reason the classifier can give has a PR that is overdue at the bound, and the set of reasons is asserted", () => {
  const byReason: Record<string, Record<string, unknown>> = {
    [STALL_REASON.RED]: { ...base, statusCheckRollup: RED },
    [STALL_REASON.CONFLICTED]: { ...base, isDraft: true, statusCheckRollup: [], mergeStateStatus: "DIRTY" },
    [STALL_REASON.AWAITING_AUTHOR_DRAFT]: { ...base, isDraft: true },
    [STALL_REASON.AWAITING_REVIEW]: { ...base, reviewDecision: "REVIEW_REQUIRED" },
    [STALL_REASON.EJECTED]: { ...base, armed: false, ejection: { removedAt: "2026-10-04T15:00:00Z", runId: 1, failingTests: null } },
    [STALL_REASON.UNARMED]: { ...base, armed: false },
    [STALL_REASON.HUNG_CHECK]: { ...base, statusCheckRollup: [{ name: "gate", status: "IN_PROGRESS", conclusion: "", startedAt: iso(NOW - 2 * 60 * MINUTE_MS) }] },
    [STALL_REASON.PROGRESSING]: { ...base, statusCheckRollup: [] },
    [STALL_REASON.HELD_ON_PURPOSE]: { ...base, labels: label("hold:ceo") },
  };
  assert.deepEqual(Object.keys(byReason).sort(), Object.values(STALL_REASON).sort(), "a reason added to the classifier has no case here until one is written");
  for (const [reason, pr] of Object.entries(byReason)) {
    const full = { ...pr, number: 100, createdAt: iso(NOW - PR_BOUND_MS), comments: [] };
    assert.equal(stallReasonOf(full, REQUIRED, NOW), reason, `the fixture for ${reason} is really ${reason}`);
    assert.equal(clock({ prs: [full] }).orders.length, 1, `${reason} is overdue at the bound -- the two states the old net exempted included`);
    assert.deepEqual(clock({ prs: [{ ...full, createdAt: iso(NOW - PR_BOUND_MS + 1) }] }).orders, [], `${reason} is not overdue a millisecond under`);
  }
});

// --- the row clock runs from the NEWEST claim record -----------------------------------------------------------------------------------------

test("a row's clock runs from its NEWEST claim record, a release is no claim, and a claimed row with no record has no age", () => {
  const rows = [{ number: 1, labels: label("in-progress", "session:worker-1") }, { number: 2, labels: label("in-progress", "session:worker-2", "hold:ceo") },
    { number: 3, labels: label("in-progress", "session:worker-3") }, { number: 4, labels: label("ready") }];
  const comments = [
    { number: 1, comments: [claimComment("worker-1", NOW - 10 * 60 * MINUTE_MS), claimComment("worker-1", NOW - 20 * MINUTE_MS)] },
    { number: 2, comments: [claimComment("worker-2", NOW - 30 * MINUTE_MS)] },
    { number: 3, comments: [{ body: "a comment and no claim record", createdAt: iso(NOW - MINUTE_MS), author: BOT }] },
  ];
  const facts = claimedRowFacts(rows, comments);
  assert.deepEqual(facts.map((f) => [f.number, f.reason, f.owner, f.since]), [
    [1, "claimed", "worker-1", NOW - 20 * MINUTE_MS],
    [2, "held", "worker-2", NOW - 30 * MINUTE_MS],
    [3, "claimed", "worker-3", null],
  ], "row 4 is not claimed, so it is not clocked; row 3 is claimed and undated, which is an unknown and not an age");
});

// --- a refused read is an UNKNOWN, never a clear and never a trip ----------------------------------------------------------------------------

test("a refused read is an UNKNOWN, never a clear and never a trip: the PR read, a PR nothing dates, the rows and the claimed rows' comments", () => {
  assert.equal(overdueReading({ now: NOW, items: null }).status, "unknown");
  const refusedPrs = overdueFacts({ prsRead: null, openRowsRead: [], claimedComments: [], required: REQUIRED, now: NOW });
  assert.equal(refusedPrs.items, null);
  const undated = overdueFacts({ prsRead: [{ ...base, number: 1, comments: [] }], openRowsRead: [], claimedComments: [], required: REQUIRED, now: NOW });
  const reading = overdueReading({ now: NOW, ...undated });
  assert.equal(reading.status, "unknown");
  assert.match(reading.detail, /carried no opening time/);
  const noComments = overdueFacts({ prsRead: [], openRowsRead: [], claimedComments: null, required: REQUIRED, now: NOW });
  assert.match(overdueReading({ now: NOW, ...noComments }).detail, /claimed rows' comments could not be read/);
  const noRows = overdueFacts({ prsRead: [], openRowsRead: null, claimedComments: [], required: REQUIRED, now: NOW });
  assert.match(overdueReading({ now: NOW, ...noRows }).detail, /open rows could not be read/);
  assert.equal(overdueReading({ now: NOW, items: [] }).status, "clear");
  assert.equal(overdueReading({ now: NOW, ...overdueFacts({ prsRead: [], openRowsRead: [], required: REQUIRED, now: NOW }) }).status, "clear",
    "a caller that does not ask for the claimed rows (`claimedComments` omitted) is silent about them, not unknown");
  const tripped = overdueReading({ now: NOW, items: [{ kind: "pr", number: 9, reason: "red", owner: null, since: NOW - PR_BOUND_MS }, ...undated.items!], unread: ["the open rows"] });
  assert.equal(tripped.status, "tripped", "a trip is a trip even when something else could not be read");
});

// --- what the order says ----------------------------------------------------------------------------------------------------------------------

test("the order names every overdue item with its kind, label, age and owner (NO OWNER when nobody can be named), oldest crossing first, and is keyed on the SET", () => {
  const owned = { ...base, number: 1, createdAt: iso(NOW - 4 * 60 * MINUTE_MS), comments: [] };
  const orphan = { ...base, number: 2, labels: [], headRefName: "main-ish", createdAt: iso(NOW - 3 * 60 * MINUTE_MS), comments: [] };
  const { orders } = clock({ prs: [orphan, owned] });
  assert.equal(orders.length, 1, "ONE order for the set");
  assert.match(orders[0].prompt, /#1 \(PR, progressing, open 4 h, owner worker-9\); #2 \(PR, progressing, open 3 h, NO OWNER\)/);
  assert.match(orders[0].prompt, /first tripped at 2026-10-04T13:40:00Z/, "the OLDEST crossing: #1 opened 12:00Z plus 100 min, derived from the opening and not remembered");
  const key = (prs: Record<string, unknown>[]) => clock({ prs }).orders[0].discriminator;
  assert.equal(key([owned, orphan]), key([orphan, owned]));
  assert.notEqual(key([owned]), key([owned, orphan]));
  assert.notEqual(key([owned]), key([{ ...owned, isDraft: true }]), "a reason that changed re-asks: who owes the next move has changed");
});

test("a row and a PR are judged against THEIR OWN bound: a row at 100 minutes is not overdue, a PR at 100 minutes is", () => {
  const row = SHAPES[3].at(PR_BOUND_MS);
  assert.deepEqual(clock(row).orders, [], "100 min is under the row bound of 135");
  assert.equal(clock(SHAPES[0].at(ROW_BOUND_MS)).orders.length, 1, "135 min is far over the PR bound");
});

// --- the gate as a process --------------------------------------------------------------------------------------------------------------------

test("THE GATE AS A PROCESS raises #149's shape -- a HELD PR with a fresh comment -- to ceo from a stub `gh`, and makes NO call to read a head commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "outcome-clock-gate-"));
  try {
    const now = Date.now();
    const pr = { ...base, number: 149, labels: label("session:worker-149", "hold:ceo"), createdAt: iso(now - 3 * 60 * MINUTE_MS), headRefName: "agent/x-149",
      comments: [{ createdAt: iso(now - MINUTE_MS), author: BOT }], author: BOT };
    writeFileSync(join(dir, "pr.json"), JSON.stringify([pr]));
    writeFileSync(join(dir, "calls.log"), "");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$*" >> "${dir}/calls.log"\ncase "$*" in\n  "pr list --state open"*) cat "${dir}/pr.json" ;;\n`
      + `  "pr list"*|"issue list"*) printf '%s' '[]' ;;\n  *) exit 1 ;;\nesac\n`);
    writeFileSync(join(dir, "journalctl"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "gh"), STUB_MODE);
    chmodSync(join(dir, "journalctl"), STUB_MODE);
    const ran = spawnSync(process.execPath, [GATE_ENTRY], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    const orders = ran.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Order);
    const offered = orders.filter((o) => o.cause === "org-health" && o.subject === SIGNALS.OVERDUE);
    assert.equal(offered.length, 1, ran.stderr);
    assert.match(offered[0].prompt, /#149 \(PR, held-on-purpose, open 3 h, owner worker-149\)/);
    const calls = readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
    assert.equal(calls.some((c) => c.startsWith("api repos/") && c.includes("/commits/")), false, "the clock needs no head-commit read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

