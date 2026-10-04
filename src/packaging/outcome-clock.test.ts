// no-token: gh -- pure: the clock is a function of facts handed in, and the one process test puts a stub `gh` on PATH under a scratch HOME; nothing here reaches the real one
/**
 * THE OUTCOME CLOCK (#3486, the chairman's "how do we make sure nothing happens again?", 2026-10-04): `overdueReading` in `org-health.mjs` and its facts in
 * `work-gate/org-health.mjs`. EVERY OPEN PR AND EVERY CLAIMED ROW HAS AN AGE SINCE IT OPENED; ONLY A MERGE OR A CLOSE STOPS IT; NO STATE EXEMPTS IT.
 *
 * THE BOUNDS ARE WRITTEN OUT AS 100 AND 135 MINUTES HERE, NEVER AS THE EXPORTED CONSTANTS, for the reason `org-health.test.ts` gives for its own: a test
 * built from the constant moves with it. `the bounds are the measurement's` pins the literals to the exports in ONE place, with the measurement beside them.
 *
 * EVERY NEW SHAPE BECOMES A FIXTURE HERE (done-when 2c of #3486): the four shapes the chairman found by hand on 2026-10-04 are in `SHAPES`, each built through
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
const { overdueFacts, claimedRowFacts } = await import("../work-gate/org-health.mjs");
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

type Order = { session: string; cause: string; subject: string; discriminator: string; prompt: string };
type Items = ReturnType<typeof overdueFacts>["items"];

/** The facts every other signal reads, every one CLEAR, so a test names only the clock. */
const quiet = (over: Record<string, unknown> = {}) => ({ now: NOW, lastMergedAt: NOW - 60 * MINUTE_MS, work: { greenPrs: 1, claimableRows: 0 }, redPrs: [],
  refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] as string[] }, primarySince: null, ...over });

/** What the gate hands the tick for these PRs and rows, through the real classifier and fact readers, and what the tick OFFERS for the clock. */
function clock({ prs = [], rows = [], comments = [] }: { prs?: Record<string, unknown>[]; rows?: Record<string, unknown>[]; comments?: Record<string, unknown>[] }) {
  const facts = overdueFacts({ prsRead: prs, openRowsRead: rows, claimedComments: comments, required: REQUIRED, now: NOW });
  const orders = orgHealthTick(quiet({ overdue: facts }) as never, { log: () => undefined }) as Order[];
  return { facts, orders: orders.filter((o) => o.subject === SIGNALS.OVERDUE) };
}

/** A claim record as the REAL writer words it (`row-claim.mjs`'s `claimRecordComment`), so the reader is tested against the writer and not a copy of it. */
const claimComment = (session: string, at: number) => ({ body: claimRecordComment({ session, branch: `agent/x-${session}`, worktree: `../wt-${session}`, nothing: null }),
  createdAt: iso(at), author: BOT });

// --- THE FOUR SHAPES OF 2026-10-04, each a state the classifier gives a name and the old net could not see ---------------------------------------

const base = { isDraft: false, statusCheckRollup: GREEN, headRefOid: HEAD, labels: label("session:worker-9"), reviews: [] as unknown[] };
type Shape = { name: string; boundMs: number; reason: string; kind: "pr" | "row";
  at: (ageMs: number) => { prs?: Record<string, unknown>[]; rows?: Record<string, unknown>[]; comments?: Record<string, unknown>[] } };

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

test("THE FOUR SHAPES ARE THE SET: a PR shape and a row shape are both here, and an emptiness above would be caught by this count", () => {
  assert.equal(SHAPES.length, 4);
  assert.deepEqual(SHAPES.map((s) => s.kind).sort(), ["pr", "pr", "pr", "row"]);
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

