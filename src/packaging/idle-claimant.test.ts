// no-token: #2999 -- nothing here runs `gh`, `git` or `herdr`; the listing, the host and the memory are literal objects handed to the pure readers.
/**
 * #2999: AN IDLE CLAIMANT THAT DECLARED NO WAIT IS A STALL, AND ITS WAIT IS A FIELD OR IT IS NAMED ONE.
 *
 * Twelve sessions sat idle for hours and each named its wait in a terminal nobody reads. THE CONTROL FOR EVERY "NOT A STALL" ASSERTION IS THE SAME
 * FIXTURE WITH THE ONE FIELD REMOVED: a holder with a reviewer requested is not a stall only because the same holder with none IS one, and each
 * wait kind clears it only because the identical input without that kind stalls. Nothing here is asserted against an empty population.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  idleClaimantReading, idleNudgePrompt, WAIT_FIELDS, IDLE_CLAIMANT_MINUTES, IDLE_CLAIMANT_MS, IDLE_STATUSES, EVIDENCE_LABEL,
} from "../idle-claimant.mjs";
import {
  claimReading, claimStalledOrders, nextStallState, nudgeKey, claimFactsFrom,
} from "../claim-stall.mjs";
import { claimRecordComment } from "../row-claim.mjs";
import { AWAITING_EVIDENCE_LABEL, claimStallTick } from "../work-gate.mjs";

const MIN = 60_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const ago = (minutes: number) => NOW - minutes * MIN;

const STANDING = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }];
const listing = (status: string, extra: { label: string; status: string }[] = []) => [...STANDING, { label: "worker-9", status }, ...extra];

/** A pull request exactly as `readPrs` returns one: green checks, a review required, nothing else. */
const GREEN_PR = { number: 2968, reviewDecision: "REVIEW_REQUIRED", labels: [], checksPending: false };

const reading = (over: { waitKinds?: string[]; prs?: object[]; agents?: unknown; idleSince?: number | null } = {}) =>
  idleClaimantReading({ session: "worker-9", waitKinds: over.waitKinds ?? [], prs: (over.prs ?? []) as never },
    { now: NOW, agents: (over.agents === undefined ? listing("idle") : over.agents) as never, idleSince: over.idleSince === undefined ? ago(50) : over.idleSince });

// --- Acceptance 1: the instance --------------------------------------------------------------------------------------------------------

test("#2999 (1) a holder idle 50 min whose PR is green with a reviewer requested is NOT a stall -- and the same holder with NO reviewer IS", () => {
  const withReviewer = reading({ prs: [GREEN_PR], agents: listing("idle", [{ label: "reviewer-2968", status: "working" }]) });
  assert.deepEqual(withReviewer, { kind: "waiting", fields: ["review-requested"] });
  const none = reading({ prs: [GREEN_PR] });
  assert.equal(none.kind, "stall", "GREEN CHECKS ARE NOT A FIELD: the pull request awaits a review nobody was asked for");
  assert.equal((none as { idleMs: number }).idleMs, 50 * MIN);
});

test("#3075 a pull request in ANOTHER tracked repository is waiting on ITS reviewer seat (`reviewer-<key>-<n>`), not on `reviewer-<n>` of the home repository", () => {
  const elsewhere = { ...GREEN_PR, number: 38, repoKey: "agent-org" };
  const seated = reading({ prs: [elsewhere], agents: listing("idle", [{ label: "reviewer-agent-org-38", status: "working" }]) });
  assert.deepEqual(seated, { kind: "waiting", fields: ["review-requested"] });
  const wrongSeat = reading({ prs: [elsewhere], agents: listing("idle", [{ label: "reviewer-38", status: "working" }]) });
  assert.equal(wrongSeat.kind, "stall", "a home PR 38's reviewer is nobody's for a pull request in the other repository");
  const home = reading({ prs: [{ ...GREEN_PR, number: 38 }], agents: listing("idle", [{ label: "reviewer-38", status: "working" }]) });
  assert.equal(home.kind, "waiting", "CONTROL: an unkeyed pull request is still read by `reviewer-<n>`");
});

test("#2999 (1) a holder with no PR and a row carrying no field IS a stall, and a `done` holder reads like an `idle` one", () => {
  assert.equal(reading().kind, "stall");
  assert.equal(reading({ agents: listing("done") }).kind, "stall");
  assert.deepEqual([...IDLE_STATUSES].sort(), ["done", "idle"], "`herdr` says `done` for a finished turn nobody has looked at: 7 of the 15 live panes at the measurement");
});

test("#2999 an idle holder short of N is `watching`, and N itself is the stall (the boundary, both sides)", () => {
  assert.equal(reading({ idleSince: NOW - IDLE_CLAIMANT_MS + 1 }).kind, "watching");
  assert.equal(reading({ idleSince: NOW - IDLE_CLAIMANT_MS }).kind, "stall");
  assert.equal(reading({ idleSince: null }).kind, "watching", "no memory yet: the first idle tick starts the clock, it does not end it");
  assert.equal(IDLE_CLAIMANT_MINUTES, 45);
});

// --- Acceptance 2: each wait kind clears it, one case per entry of the exported set --------------------------------------------------------

const PR_WITH_REVIEWER = { prs: [GREEN_PR], agents: listing("idle", [{ label: "reviewer-2968", status: "idle" }]) };
const CASE: Record<string, Parameters<typeof reading>[0]> = {
  "blocked-by": { waitKinds: ["blocked-by"] },
  "not-before": { waitKinds: ["not-before"] },
  "answer": { waitKinds: ["answer"] },
  "chairman": { waitKinds: ["chairman"] },
  "fleet-hold": { waitKinds: ["fleet-hold"] },
  "review-requested": PR_WITH_REVIEWER,
  "checks-pending": { prs: [{ ...GREEN_PR, checksPending: true }] },
  "review-approved": { prs: [{ ...GREEN_PR, reviewDecision: "APPROVED" }] },
  "awaiting-evidence": { prs: [{ ...GREEN_PR, labels: [{ name: EVIDENCE_LABEL }] }] },
};

test("#2999 (2) the case table covers EXACTLY the exported wait-field set, so a new kind cannot be added without a case", () => {
  assert.deepEqual(Object.keys(CASE).sort(), Object.keys(WAIT_FIELDS).sort());
  assert.ok(Object.keys(WAIT_FIELDS).length >= 5, "the population is not empty, so the loop below runs");
});

for (const kind of Object.keys(WAIT_FIELDS)) {
  test(`#2999 (2) wait kind \`${kind}\` clears the stall, and the same holder without it is one`, () => {
    const withIt = reading(CASE[kind]);
    assert.equal(withIt.kind, "waiting", `${kind} must clear it`);
    assert.ok((withIt as { fields: string[] }).fields.includes(kind), `and be the one named, got ${JSON.stringify(withIt)}`);
    const without = reading({ agents: listing("idle", [{ label: "reviewer-2968", status: "idle" }]).filter((a) => !a.label.startsWith("reviewer-")) });
    assert.equal(without.kind, "stall", "the control: no field at all stalls");
  });
}

test("#2999 `awaiting-evidence` is the gate's own label, and `blocked` (a claim with no referent) is NOT a wait field", () => {
  assert.equal(EVIDENCE_LABEL, AWAITING_EVIDENCE_LABEL);
  assert.equal(Object.hasOwn(WAIT_FIELDS, "blocked"), false);
});

// --- Acceptance 3: working / blocked never trip it, a partial listing is `unknown` -----------------------------------------------------------

test("#2999 (3) a `working` or `blocked` session never trips it, and the same holder `idle` does", () => {
  assert.equal(reading({ agents: listing("idle") }).kind, "stall");
  for (const status of ["working", "blocked", "unknown"]) {
    assert.deepEqual(reading({ agents: listing(status) }), { kind: "not-idle", status }, status);
  }
  assert.deepEqual(reading({ agents: STANDING }), { kind: "not-idle", status: null }, "absent from a complete listing is `goneReading`'s, not a stall");
});

test("#2999 (3) a PARTIAL listing is `unknown`, never a stall (#2465) -- even when it names the holder -- and a refused one is `unknown` too", () => {
  const partial = [{ label: "worker-9", status: "idle" }];
  assert.equal(reading({ agents: partial }).kind, "unknown");
  assert.equal(reading({ agents: [...STANDING.slice(0, 1), { label: "worker-9", status: "idle" }] }).kind, "unknown", "one standing pane is still not the org");
  assert.equal(reading({ agents: null }).kind, "unknown");
  assert.equal(reading({ agents: listing("idle") }).kind, "stall", "the control: the complete listing of the same holder stalls");
});

// --- Acceptance 4: the text names the field spellings ---------------------------------------------------------------------------------------

test("#2999 (4) the nudge names every row-field spelling and the pull-request waits, so `name your wait` never means `write it in the terminal`", () => {
  const text = idleNudgePrompt({ row: 2999, branch: "agent/x-2999", idleMinutes: 50, releaseMinutes: 120, canRelease: true });
  const rowSpellings = Object.values(WAIT_FIELDS).filter((f) => f.on === "row").map((f) => f.spelling);
  assert.ok(rowSpellings.length >= 5);
  for (const spelling of rowSpellings) assert.ok(text.includes(spelling), `the nudge must spell \`${spelling}\``);
  assert.match(text, /NAME WHAT YOU WAIT FOR AS A FIELD, OR CONTINUE/);
  assert.ok(text.includes(EVIDENCE_LABEL));
  assert.match(text, /RELEASED/, "a holder that can be released is told so");
  assert.doesNotMatch(idleNudgePrompt({ row: 1, branch: null, idleMinutes: 50, releaseMinutes: 120, canRelease: false }), /RELEASED/,
    "and one holding a pull request is not told a threat that will not be carried out");
});

// --- the nudge and the second reading, through `claimReading` ------------------------------------------------------------------------------

const facts = (over: object = {}) => ({ row: 2999, session: "worker-9", claimedAt: ago(60), branch: "agent/x-2999", worktree: null,
  comment: null, commit: null, push: null, file: () => null, work: () => ({ state: "none", dirty: 0, unpushed: 0 }),
  openPrs: 0, mergedPr: null, waiting: null, blockedBy: [], ownPrs: [], ...over }) as unknown as Parameters<typeof claimReading>[0];
const ctx = (over: object = {}) => ({ now: NOW, restartAt: null, nudge: null, agents: listing("idle"), goneSince: null, idleSince: ago(50), ...over }) as
  Parameters<typeof claimReading>[1];

test("#2999 a holder with an open PR is `pr-owned` for the clock and a nudge for the overlay -- unless a reviewer is requested", () => {
  const pr = { number: 2968, reviewDecision: "REVIEW_REQUIRED", labels: [], checksPending: false };
  const nudged = claimReading(facts({ openPrs: 1, ownPrs: [pr] }), ctx());
  assert.equal(nudged.kind, "nudge");
  assert.equal((nudged as { idle?: boolean }).idle, true);
  const reviewed = claimReading(facts({ openPrs: 1, ownPrs: [pr] }), ctx({ agents: listing("idle", [{ label: "reviewer-2968", status: "working" }]) }));
  assert.deepEqual(reviewed, { kind: "pr-owned" }, "the control: the same holder with a reviewer asked for is left alone");
});

test("#2999 an idle holder short of N is remembered (`idle-watch`), and a `working` one is not", () => {
  const first = claimReading(facts(), ctx({ idleSince: null }));
  assert.deepEqual(first, { kind: "idle-watch", since: NOW });
  const state = nextStallState({}, [{ facts: facts(), reading: first }] as never, NOW);
  assert.deepEqual(state, { 2999: { session: "worker-9", idleSince: NOW } });
  assert.equal(claimReading(facts(), ctx({ agents: listing("working") })).kind, "moving");
  assert.deepEqual(nextStallState(state, [{ facts: facts(), reading: { kind: "moving", lastMoveAt: NOW } }] as never, NOW), {}, "working again: the clock is reset");
});

test("#2999 a partial listing neither starts nor resets the idle clock", () => {
  const partial = [{ label: "worker-9", status: "idle" }];
  assert.equal(claimReading(facts(), ctx({ agents: partial, idleSince: null })).kind, "moving", "nothing to remember yet");
  assert.deepEqual(claimReading(facts(), ctx({ agents: partial, idleSince: ago(30) })), { kind: "idle-watch", since: ago(30) });
});

test("#2999 the nudge is the claim-stalled cause under the claim-stalled key, and the order spells the fields", () => {
  const f = facts();
  const reading1 = claimReading(f, ctx());
  const [order] = claimStalledOrders([{ facts: f, reading: reading1 }] as never, NOW);
  assert.equal(order.cause, "claim-stalled");
  assert.equal(order.causeKey, nudgeKey("worker-9", 2999, NOW), "ONE key spelling, so the ledger's delivery and the release find it");
  assert.match(order.prompt, /Not-before: YYYY-MM-DDTHH:MM:SSZ/);
  assert.equal(order.resume, true);
});

test("#2999 the SECOND reading releases a no-PR holder that was told and moved nothing for N -- the controls answer, move or are not yet due", () => {
  const old = { claimedAt: ago(400) };
  const nudge = (deliveredAt: number | null, nudgedAt = ago(130)) => ({ nudgedAt, deliveredAt, idle: true });
  const released = claimReading(facts(old), ctx({ nudge: nudge(ago(121)), agents: listing("working") }));
  assert.equal(released.kind, "release", "a nudge wakes its holder, so it is `working` by now: the status must not drop the memory");
  assert.equal((released as { why: string }).why, "stalled");
  assert.equal((released as { idle?: boolean }).idle, true, "and the release says it was the idle reading's, so the log names the cause");
  assert.equal(claimReading(facts(old), ctx({ nudge: nudge(ago(60)) })).kind, "nudged", "told only 60 minutes ago: not yet due");
  assert.equal(claimReading(facts(old), ctx({ nudge: nudge(null) })).kind, "nudged", "untold, short of twice N");
  assert.equal(claimReading(facts(old), ctx({ nudge: nudge(null, ago(250)) })).kind, "release", "untold, past twice N");
  assert.equal(claimReading(facts({ ...old, waiting: "not before 2026-10-03" }), ctx({ nudge: nudge(ago(121)) })).kind, "waiting", "a field answers it");
});

test("#2999 before the clock's own interval a remembered idle nudge is HELD as `nudged` -- and a move after it, or going back to work with a field, drops it", () => {
  const nudge = { nudgedAt: ago(10), deliveredAt: ago(8), idle: true };
  const held = claimReading(facts(), ctx({ nudge, agents: listing("working") }));
  assert.equal(held.kind, "nudged", "base says `moving` (claimed 60 minutes ago): without the overlay the nudge memory would be dropped here");
  assert.deepEqual(nextStallState({}, [{ facts: facts(), reading: held }] as never, NOW), { 2999: { session: "worker-9", nudgedAt: ago(10), idle: true } });
  assert.equal(claimReading(facts({ commit: ago(5) }), ctx({ nudge, idleSince: ago(2) })).kind, "idle-watch", "a commit after the nudge is a move: the idle clock starts afresh");
  assert.equal(claimReading(facts({ commit: ago(5) }), ctx({ nudge, agents: listing("working") })).kind, "moving", "and a holder back at work is simply moving");
});

test("#2999 a holder with an open PR is NEVER released by the idle reading: it stays `nudged`", () => {
  const pr = { number: 2968, reviewDecision: "REVIEW_REQUIRED", labels: [], checksPending: false };
  const told = { nudgedAt: ago(400), deliveredAt: ago(300), idle: true };
  const held = claimReading(facts({ openPrs: 1, ownPrs: [pr], claimedAt: ago(500) }), ctx({ nudge: told }));
  assert.equal(held.kind, "nudged");
  assert.equal(claimReading(facts({ claimedAt: ago(500) }), ctx({ nudge: told })).kind, "release", "the control: the same memory on a holder with no PR releases");
});

// --- the gate wiring: one decider for "has a wait field" ----------------------------------------------------------------------------------

const BRANCH = "agent/x-2999";
const claimRow = (body: string, labels: string[] = []) => ({ number: 2999, title: "row", body, blockedBy: { nodes: [] },
  labels: ["in-progress", "session:worker-9", ...labels].map((name) => ({ name })) });
const claimComment = { body: claimRecordComment({ session: "worker-9", branch: BRANCH, worktree: "../wt-2999" }), createdAt: new Date(ago(200)).toISOString(),
  author: { login: "a11ign-ai-workers" } };
const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

function gateTick(row: object, { prs = [] as object[], agents = listing("idle"), memory = { 2999: { session: "worker-9", idleSince: ago(50) } } as Record<string, unknown> } = {}) {
  return claimStallTick({ rows: [row], claimedComments: [{ number: 2999, comments: [claimComment] }], openPrs: prs, mergedPrs: null, io: noGit,
    repo: "/repo", now: NOW, restartAt: null, agents, stateDir: "/state", ledger: () => "", log: () => undefined,
    read: () => JSON.parse(JSON.stringify(memory)), write: () => undefined } as never) as { prompt: string; cause: string }[];
}

test("#2999 through the gate: a row carrying a future `Not-before:` or `needs:chairman` is not nudged, and the same row without one IS", () => {
  assert.equal(gateTick(claimRow("")).length, 1, "the control: an idle holder with no field is nudged");
  assert.equal(gateTick(claimRow("Not-before: 2099-01-01")).length, 0);
  assert.equal(gateTick(claimRow("", ["needs:chairman"])).length, 0);
  assert.equal(gateTick(claimRow("", ["answer:product-manager"])).length, 0, "an answer owed by ANOTHER session is a wait");
  assert.equal(gateTick(claimRow("", ["answer:worker-9"])).length, 1, "an answer owed BY THE HOLDER is the row waiting on the holder, which `declaredWait` already refuses to read as one");
});

test("#2999 through the gate: only the NEWEST run per check name decides `checks-pending`, so a superseded pending run is not a wait", () => {
  const stale = { name: "gate", status: "IN_PROGRESS", startedAt: "2026-10-02T10:00:00Z", completedAt: "0001-01-01T00:00:00Z" };
  const done = { name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-02T10:05:00Z", completedAt: "2026-10-02T10:09:00Z" };
  const newer = { name: "gate", status: "IN_PROGRESS", startedAt: "2026-10-02T10:20:00Z", completedAt: "0001-01-01T00:00:00Z" };
  const pr = (statusCheckRollup: object[]) => ({ number: 2968, headRefName: BRANCH, reviewDecision: "REVIEW_REQUIRED", labels: [], statusCheckRollup });
  assert.equal(gateTick(claimRow(""), { prs: [pr([stale, done])] }).length, 1, "the newer, completed run settles it: the holder is nudged");
  assert.equal(gateTick(claimRow(""), { prs: [pr([done, newer])] }).length, 0, "the control: the pending run NEWER than the completed one is a wait");
});

test("#2999 through the gate: an open PR with a live `reviewer-<n>` is not nudged; without it the holder is, and `claimFactsFrom` carries the PR", () => {
  const pr = { number: 2968, headRefName: BRANCH, reviewDecision: "REVIEW_REQUIRED", labels: [], checksPending: false };
  assert.equal(gateTick(claimRow(""), { prs: [pr] }).length, 1);
  assert.equal(gateTick(claimRow(""), { prs: [pr], agents: listing("idle", [{ label: "reviewer-2968", status: "working" }]) }).length, 0);
  const built = claimFactsFrom({ row: 2999, session: "worker-9", waiting: null, blockedBy: [], comments: [claimComment], openPrs: [pr], mergedPrs: null,
    repo: "/repo", waitKind: "not-before" }, noGit as never) as { ownPrs: unknown[]; waitKind: string };
  assert.deepEqual(built.ownPrs, [pr]);
  assert.equal(built.waitKind, "not-before");
});
