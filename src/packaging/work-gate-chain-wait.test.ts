// no-token: gh -- nothing here reaches `gh`; the pull requests are fixtures and the state directory is a temp one
/**
 * a11ign#5126: A HOLDER WAITING ON A PULL REQUEST THAT IS ITSELF BLOCKED IS WOKEN WITH THE CHOICE AFTER 30 MINUTES; A SECOND PERIOD GOES TO ORCHESTRATOR.
 *
 * THE SHAPE, 2026-10-11: #1016 (worker-5117) waited for #1014 to merge, "then rebase once"; #1014 had changes requested and a red `suite`, so #1016 sat DIRTY behind a change nobody was working.
 * #5009's detector names a CYCLE. This is a CHAIN, with nothing circular in it, and each hop was correct, so nothing moved and nothing cleared it.
 *
 * Every case is reached through `chainWaitOrders`, the call the tick makes (flag, state file, clock and all); the pure halves have their own cases where a rule is worth stating alone.
 * The row's named case is the first test: the #1016 -> #1014 shape wakes #1016's holder after 30 minutes, once, and the second period escalates.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyCanaryState } from "../org-health/fleet-build-readings.ts";
import { withMachineryFlag } from "../org-health.ts";
import { CHAIN_WAIT_ESCALATION_SESSION, CHAIN_WAIT_FILE, CHAIN_WAIT_FLAG, CHAIN_WAIT_MINUTES, advanceChainWaits, blockedReasonOf, chainWaitOrders, chainWaitsOf } from "../work-gate/causes/org-health-chain-wait.ts";

const MINUTE = 60 * 1000;
const T0 = Date.parse("2026-10-11T18:00:00Z");
/** The gate ticks about every five minutes: well inside `MAX_TICK_GAP_MS`, so a run of ticks is one observation. */
const TICK = 5 * MINUTE;

const ON = withMachineryFlag(emptyCanaryState(), { name: CHAIN_WAIT_FLAG, on: true });
const OFF = emptyCanaryState();

// --- the world: pull requests as `readPrs` hands them over --------------------------------------------------------------------------------------

type Pr = Record<string, unknown>;

/** A pull request that is not blocked: approved, no conflict, green. */
const clean = (number: number, extra: Pr = {}): Pr => ({
  number, labels: [], body: "", comments: [], reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
  statusCheckRollup: [{ name: "suite", conclusion: "SUCCESS", completedAt: "2026-10-11T17:00:00Z" }], ...extra,
});

/** #1014 as it stood: changes requested and a red `suite`. */
const BLOCKED_1014 = clean(1014, { reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ name: "suite", conclusion: "FAILURE", completedAt: "2026-10-11T17:00:00Z" }] });
/** #1016 as it stood: held by `worker-5117`, waiting for #1014 to merge, conflicting behind it. */
const HOLDER_1016 = clean(1016, { labels: [{ name: "session:worker-5117" }], body: "Waiting-for: merged #1014\n", mergeStateStatus: "DIRTY", mergeable: "CONFLICTING", reviewDecision: "" });

const made: string[] = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), "chain-wait-"));
  made.push(path);
  return path;
};
/** The suite's private TMPDIR is checked empty at teardown, so what was made is removed, and a directory a case made read-only is made writable first. */
after(() => {
  for (const path of made) {
    chmodSync(path, 0o700);
    rmSync(path, { recursive: true, force: true });
  }
});

/** One tick of the real entry point, `minutes` after the first. Lines the gate printed are collected. */
function tick({ prs, rows = [], stateDir, minutes, state = ON }: { prs: Pr[]; rows?: Pr[]; stateDir: string; minutes: number; state?: ReturnType<typeof emptyCanaryState> }) {
  const lines: string[] = [];
  const orders = chainWaitOrders({ prs, rows, stateDir, state, now: T0 + minutes * MINUTE, log: (line) => lines.push(line) });
  return { orders, lines };
}

/** Ticks every five minutes from 0 to `through` inclusive; returns each tick's orders by minute. */
function run({ prs, stateDir, through, rows = [], from = 0, state = ON }: { prs: Pr[]; stateDir: string; through: number; rows?: Pr[]; from?: number; state?: typeof ON }) {
  const byMinute: Record<number, ReturnType<typeof tick>["orders"]> = {};
  for (let minutes = from; minutes <= through; minutes += TICK / MINUTE) byMinute[minutes] = tick({ prs, rows, stateDir, minutes, state }).orders;
  return byMinute;
}

const ordersOf = (byMinute: Record<number, ReturnType<typeof tick>["orders"]>) => Object.entries(byMinute).flatMap(([minute, orders]) => orders.map((order) => ({ minute: Number(minute), order })));

// --- the named case --------------------------------------------------------------------------------------------------------------------------

test("the #1016 -> #1014 chain wakes #1016's holder after 30 minutes, once, and a second period escalates to orchestrator (a11ign/a11ign#5126)", () => {
  const stateDir = dir();
  const sent = ordersOf(run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, through: 90 }));
  assert.equal(sent.length, 2, "one wake and one escalation across ninety minutes of standing ticks, not one per tick");

  const [wake, escalation] = sent;
  assert.equal(wake.minute, CHAIN_WAIT_MINUTES, "nothing before thirty minutes: the clock starts on the first tick that reads the chain");
  assert.equal(wake.order.session, "worker-5117");
  assert.match(wake.order.prompt, /#1016/);
  assert.match(wake.order.prompt, /#1014/);
  assert.match(wake.order.prompt, /a reviewer requested changes/);
  assert.match(wake.order.prompt, /rebase/i, "the choice names the rebase");
  assert.match(wake.order.prompt, /regenerate/i, "and the regeneration of what conflicts");
  assert.match(wake.order.prompt, /take #1014's change/, "and the other way out");

  assert.equal(escalation.minute, 2 * CHAIN_WAIT_MINUTES, "the second period, counted from the wake");
  assert.equal(escalation.order.session, CHAIN_WAIT_ESCALATION_SESSION);
  assert.match(escalation.order.prompt, /worker-5117 was woken 30 minutes ago/);
  assert.notEqual(escalation.order.causeKey, wake.order.causeKey, "the escalation is its own order, not a second copy of the wake");
});

test("nothing is sent before the period has run: every tick of the first thirty minutes is silent", () => {
  const stateDir = dir();
  const early = run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, through: CHAIN_WAIT_MINUTES - 5 });
  assert.deepEqual(ordersOf(early), []);
  const written = JSON.parse(readFileSync(join(stateDir, CHAIN_WAIT_FILE), "utf8"));
  assert.equal(Object.keys(written.episodes).length, 1, "the clock IS running: the chain is on record, so the silence is the period and not a miss");
});

// --- what is and is not a chain ------------------------------------------------------------------------------------------------------------

test("a blocked pull request is one that changes were requested on, that conflicts, or that is red; one still running its checks is not", () => {
  assert.equal(blockedReasonOf(BLOCKED_1014), "a reviewer requested changes");
  assert.equal(blockedReasonOf(clean(1, { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" })), "it conflicts with its base");
  assert.match(String(blockedReasonOf(clean(2, { statusCheckRollup: [{ name: "suite", conclusion: "FAILURE", completedAt: "2026-10-11T17:00:00Z" }] }))), /^its checks are red \(suite\)$/);
  assert.equal(blockedReasonOf(clean(3, { statusCheckRollup: [{ name: "suite", conclusion: null, status: "IN_PROGRESS", startedAt: "2026-10-11T17:00:00Z" }] })), null, "pending is not blocked");
  assert.equal(blockedReasonOf(clean(4, { mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" })), null, "an unread merge state is not read as a conflict");
  assert.equal(blockedReasonOf(clean(5)), null);
});

test("a hold's own two red jobs are the hold speaking, so a held pull request is not 'blocked' for them", () => {
  const held = clean(7, {
    labels: [{ name: "hold:ceo" }],
    statusCheckRollup: [{ name: "gate", conclusion: "FAILURE", completedAt: "2026-10-11T17:00:00Z" }, { name: "deliberateRefusals", conclusion: "FAILURE", completedAt: "2026-10-11T17:00:00Z" }],
  });
  assert.equal(blockedReasonOf(held), null);
});

test("a wait on a pull request that is NOT blocked is not a chain, and neither is a wait on one the gate did not list", () => {
  assert.deepEqual(chainWaitsOf({ prs: [clean(1014), HOLDER_1016], rows: [] }), [], "#1014 is green and approved: it will merge on its own");
  assert.deepEqual(chainWaitsOf({ prs: [HOLDER_1016], rows: [] }), [], "#1014 is not in the list: absence is not a block");
});

test("a wait that is not on a merge or a close is not a chain: a label, a release and a manual wait are other conditions", () => {
  const others = ["labelled needs-review #1014", "published @a11ign/pkg@next", "manual", "soon"].map((wait, at) => clean(2000 + at, { labels: [{ name: "session:worker-1" }], body: `Waiting-for: ${wait}\n` }));
  assert.deepEqual(chainWaitsOf({ prs: [BLOCKED_1014, ...others], rows: [] }), []);
});

test("a hold marker comment's wait is the declared one, as everywhere else the gate reads waits", () => {
  const marked = clean(1016, {
    labels: [{ name: "session:worker-5117" }], body: "",
    comments: [{ body: "<!-- pr-hold-until -->\nWaiting-for: merged #1014\n", createdAt: "2026-10-11T16:00:00Z" }],
  });
  const chains = chainWaitsOf({ prs: [BLOCKED_1014, marked], rows: [] });
  assert.equal(chains.length, 1);
  assert.equal(chains[0].holder, "#1016");
});

test("a row and the pull request that closes it declaring the same wait on the same holder session are ONE chain", () => {
  const row = { number: 5000, labels: [{ name: "session:worker-5117" }], body: "Waiting-for: merged #1014\n", comments: [] };
  const chains = chainWaitsOf({ prs: [BLOCKED_1014, HOLDER_1016], rows: [row] });
  assert.equal(chains.length, 1, "one wake per (session, blocked pull request), not one per item");
});

test("a pull request waiting on ITSELF is not a chain", () => {
  const selfish = clean(9, { reviewDecision: "CHANGES_REQUESTED", labels: [{ name: "session:worker-1" }], body: "Waiting-for: merged #9\n" });
  assert.deepEqual(chainWaitsOf({ prs: [selfish], rows: [] }), []);
});

test("a wait in another repository names that repository's pull request, not the home one with the same number", () => {
  const away = { ...clean(1014, { reviewDecision: "CHANGES_REQUESTED" }), repoKey: "agent-org", repo: "a11ign/agent-org" };
  const holder = clean(55, { labels: [{ name: "session:worker-2" }], body: "Waiting-for: merged a11ign/agent-org#1014\n" });
  const chains = chainWaitsOf({ prs: [away, holder], rows: [] });
  assert.equal(chains.length, 1);
  assert.equal(chains[0].target, "a11ign/agent-org#1014");
  assert.deepEqual(chainWaitsOf({ prs: [away, clean(56, { labels: [{ name: "session:worker-2" }], body: "Waiting-for: merged #1014\n" })], rows: [] }), [], "a bare #1014 is the home repository's, which was not listed");
});

test("the order's subject is the established `pr-<ref>` spelling: `pr-1014` for the home repository, `pr-agent-org#1014` for a keyed one, never a slug of the display name", () => {
  const home = ordersOf(run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir: dir(), through: 60 }));
  assert.deepEqual(home.map(({ order }) => order.subject), ["pr-1014", "pr-1014"], "the wake and the escalation both name the blocked pull request");
  const away = { ...clean(1014, { reviewDecision: "CHANGES_REQUESTED" }), repoKey: "agent-org", repo: "a11ign/agent-org" };
  const holder = clean(55, { labels: [{ name: "session:worker-2" }], body: "Waiting-for: merged a11ign/agent-org#1014\n" });
  const keyed = ordersOf(run({ prs: [away, holder], stateDir: dir(), through: 30 }));
  assert.deepEqual(keyed.map(({ order }) => order.subject), ["pr-agent-org#1014"]);
  assert.doesNotMatch(String(keyed[0].order.subject), /pr--|a11ign/, "the display name's `#` and `/` are not slugged into the subject");
});

// --- the moves -----------------------------------------------------------------------------------------------------------------------------

test("a holder no session is known for goes straight to the escalation, because nobody could take the choice", () => {
  const nobody = clean(1016, { body: "Waiting-for: merged #1014\n" });
  const sent = ordersOf(run({ prs: [BLOCKED_1014, nobody], stateDir: dir(), through: 90 }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].order.session, CHAIN_WAIT_ESCALATION_SESSION);
  assert.equal(sent[0].minute, CHAIN_WAIT_MINUTES);
  assert.match(sent[0].order.prompt, /nobody could be woken/);
});

test("a chain that clears is forgotten and logged; when it stands again it starts a NEW clock and wakes once that has run", () => {
  const stateDir = dir();
  assert.equal(ordersOf(run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, through: 30 })).length, 1, "the first standing woke its holder");
  const cleared = tick({ prs: [clean(1014), HOLDER_1016], stateDir, minutes: 35 });
  assert.deepEqual(cleared.orders, []);
  assert.match(cleared.lines.join(""), /no longer standing/);
  assert.deepEqual(ordersOf(run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, from: 40, through: 65 })), [], "twenty-five minutes into the new standing: the old wake does not carry");
  const again = ordersOf(run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, from: 70, through: 70 }));
  assert.equal(again.length, 1, "thirty minutes after the new first reading, the holder is woken again");
  assert.equal(again[0].order.session, "worker-5117");
});

test("a gap in observation starts the clock again: minutes nobody observed are not counted", () => {
  const stateDir = dir();
  tick({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, minutes: 0 });
  const afterGap = tick({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, minutes: 120 });
  assert.deepEqual(afterGap.orders, [], "two hours later is not thirty minutes of standing: the gate was not looking");
  const resumed = ordersOf(run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, from: 125, through: 150 }));
  assert.deepEqual(resumed.map(({ minute }) => minute), [150], "thirty minutes after the new first reading, at minute 150 and not at 30");
});

test("the wake's discriminator carries the episode's start, so two chains of the same pair are two orders", () => {
  const seen = chainWaitsOf({ prs: [BLOCKED_1014, HOLDER_1016], rows: [] });
  const one = advanceChainWaits({}, seen, T0);
  const woken = advanceChainWaits(one.episodes, seen, T0 + CHAIN_WAIT_MINUTES * MINUTE);
  assert.equal(woken.moves.length, 1);
  assert.equal(woken.moves[0].kind, "wake-holder");
  assert.equal(woken.moves[0].since, T0);
});

// --- the flag, and the record --------------------------------------------------------------------------------------------------------------

test("flag OFF is today's gate: no order, and nothing read or written", () => {
  const stateDir = dir();
  assert.deepEqual(ordersOf(run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, through: 90, state: OFF })), []);
  assert.throws(() => readFileSync(join(stateDir, CHAIN_WAIT_FILE)), /ENOENT/, "off writes no state either, so turning it on starts from nothing, not from a stale clock");
});

test("the OFF case's control: the identical world and clock with the flag ON sends, so the silence above is the flag", () => {
  assert.equal(ordersOf(run({ prs: [BLOCKED_1014, HOLDER_1016], stateDir: dir(), through: 90, state: ON })).length, 2);
});

test("a record that cannot be written sends NO order, and says so: a wake whose memory was lost would be sent again on the next tick", { skip: process.getuid?.() === 0 && "root can write a read-only file" }, () => {
  const stateDir = dir();
  const file = join(stateDir, CHAIN_WAIT_FILE);
  const episode = { since: T0, woke: null, escalated: false };
  writeFileSync(file, JSON.stringify({ at: T0 + 25 * MINUTE, episodes: { "worker-5117->#1014": episode } }));
  chmodSync(stateDir, 0o500); // the record is written to `<file>.tmp` and renamed, so the directory is what must refuse
  const result = tick({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, minutes: 30 });
  assert.deepEqual(result.orders, [], "the thirty minutes HAVE run, so the order was owed, and is withheld because it could not be remembered");
  assert.match(result.lines.join(""), /the record was not kept/);
  chmodSync(stateDir, 0o700);
  assert.equal(tick({ prs: [BLOCKED_1014, HOLDER_1016], stateDir, minutes: 30 }).orders.length, 1, "control: the same record, writable, sends it");
});

test("the chain wait neither changes nor reads another pull request's order: a world with no chain returns nothing and writes an empty record", () => {
  const stateDir = dir();
  assert.deepEqual(tick({ prs: [clean(1), clean(2)], stateDir, minutes: 0 }).orders, []);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, CHAIN_WAIT_FILE), "utf8")).episodes, {});
});
