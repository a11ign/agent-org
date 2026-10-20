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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_STATE_DIR, writeDeclaration, type Declaration } from "../worker-state.ts";
import {
  idleClaimantReading, idleNudgePrompt, WAIT_FIELDS, IDLE_CLAIMANT_MINUTES, IDLE_CLAIMANT_MS, IDLE_STATUSES, EVIDENCE_LABEL, HOLD_LABEL_PREFIX,
  redOwnPrs, redCheckNudgePrompt, unansweredNudgeNote, idleLimitMs, stoppedNudgePrompt, MAX_UNANSWERED_NUDGES, STOPPED_CLAIMANT_MS,
} from "../idle-claimant.ts";
import { HOLD_PREFIX } from "../pr-hold-state.ts";
import { brokenChecks } from "../red-pr.ts";
import { claimReading, claimFactsFrom, withRedChecks } from "../claim-stall/stall-causes-and-claim-readings.ts";
import { claimStalledOrders, nextStallState, nudgeKey, stalledNudgeEvents } from "../claim-stall.ts";
import { claimRecordComment } from "../row-claim.ts";
import { AWAITING_EVIDENCE_LABEL } from "../work-gate/causes/pr-reviews.ts";
import { claimStallTick } from "../work-gate/claim-stall-tick.ts";

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
  assert.equal(IDLE_CLAIMANT_MINUTES, 30);
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
  // #3569: an external event with a GitHub referent, held through `pr:hold --until`.
  "pr-held": { prs: [{ ...GREEN_PR, labels: [{ name: `${HOLD_PREFIX}worker-9` }] }] },
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
  assert.equal(HOLD_LABEL_PREFIX, HOLD_PREFIX, "#3569: the leaf's restatement of the hold prefix cannot drift from `pr-hold-state.ts`'s");
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
  assert.ok(text.includes("pr:hold"), "#3569: an event outside the repository is a hold with a condition, and the nudge says so");
  assert.match(text, /RELEASED/, "a holder that can be released is told so");
  assert.doesNotMatch(idleNudgePrompt({ row: 1, branch: null, idleMinutes: 50, releaseMinutes: 120, canRelease: false }), /RELEASED/,
    "and one holding a pull request is not told a threat that will not be carried out");
});

// --- the nudge and the second reading, through `claimReading` ------------------------------------------------------------------------------

const facts = (over: object = {}) => ({ row: 2999, session: "worker-9", claimedAt: ago(60), branch: "agent/x-2999", worktree: null,
  comment: null, commit: () => null, push: () => null, file: () => null, work: () => ({ state: "none", dirty: 0, unpushed: 0 }),
  openPrs: 0, mergedPr: null, waiting: null, blockedBy: [], ownPrs: [], ...over }) as unknown as Parameters<typeof claimReading>[0];
const ctx = (over: object = {}) => ({ now: NOW, restartAt: null, nudge: null, agents: listing("idle"), goneSince: null, idleSince: ago(50), ...over }) as
  Parameters<typeof claimReading>[1];

test("#2999 (agent-org#805) a holder with an open PR is `pr-owned` for the clock and for the overlay, reviewer or not; with no PR it is the nudge", () => {
  const pr = { number: 2968, reviewDecision: "REVIEW_REQUIRED", labels: [], checksPending: false };
  const nudged = claimReading(facts({ openPrs: 1, ownPrs: [pr] }), ctx());
  assert.deepEqual(nudged, { kind: "pr-owned" }, "agent-org#805: an open pull request of the holder's is never a nudge, with or without a reviewer");
  assert.equal(claimReading(facts({ openPrs: 0 }), ctx()).kind, "nudge", "CONTROL: with NO open pull request the same holder is nudged");
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
  assert.equal(claimReading(facts({ commit: () => ago(5) }), ctx({ nudge, idleSince: ago(2) })).kind, "idle-watch", "a commit after the nudge is a move: the idle clock starts afresh");
  assert.equal(claimReading(facts({ commit: () => ago(5) }), ctx({ nudge, agents: listing("working") })).kind, "moving", "and a holder back at work is simply moving");
});

test("#2999 a holder with an open PR is NEVER released by the idle reading (agent-org#805: it is `pr-owned`, not `nudged`)", () => {
  const pr = { number: 2968, reviewDecision: "REVIEW_REQUIRED", labels: [], checksPending: false };
  const told = { nudgedAt: ago(400), deliveredAt: ago(300), idle: true };
  // delivered 300 minutes ago and idle since ago(50): ONE unanswered nudge, so the next nudge and not a release
  const held = claimReading(facts({ openPrs: 1, ownPrs: [pr], claimedAt: ago(500) }), ctx({ nudge: told }));
  assert.equal(held.kind, "pr-owned", "agent-org#805: an open PR is pr-owned, so the told memory neither releases it nor reads as a nudge");
  assert.equal(claimReading(facts({ claimedAt: ago(500) }), ctx({ nudge: told })).kind, "release", "the control: the same memory on a holder with no PR releases");
});

// --- agent-org#743 (a11ign#4437): A RED PULL REQUEST IS TOLD WITHIN M, WHATEVER WAS DECLARED, AND THREE UNANSWERED NUDGES RELEASE --------------------------------
//
// THE CONTROL FOR EVERY "NOT NUDGED" IS THE SAME FIXTURE WITH ONE THING CHANGED: a `waiting-review` holder is excused only because the same holder with a red check is not,
// the count releases only at the third because the second is a nudge, and a commit resets it only because the same nudge with none is counted on.
// MUTATION (run by hand, on the PR): `redOwnPrs` always empty fails (1), (2) and the order text; always non-empty fails the GREEN controls; `MAX_UNANSWERED_NUDGES` read as 2
// fails (4)'s second-does-not; a `progress` that counts a comment fails (5)'s comment control; one that ignores a commit fails (5)'s reset.

const CHECK = { startedAt: "2026-10-02T11:00:00Z", completedAt: "2026-10-02T11:10:00Z" };
const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", ...CHECK }];
const RED_TS = [{ name: "ts", status: "COMPLETED", conclusion: "FAILURE", ...CHECK }, { name: "gate", status: "COMPLETED", conclusion: "FAILURE", ...CHECK }];
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", ...CHECK }];
const redPr = (rollup: object[] = RED, over: object = {}) => ({ number: 2968, reviewDecision: "REVIEW_REQUIRED", labels: [], checksPending: false, statusCheckRollup: rollup, ...over });
const declare = (state: string) => ({ kind: "excused", state, why: "its pull request is open" });
const onPr = (pr: object, over: object = {}) => facts({ openPrs: 1, ownPrs: [pr], claimedAt: ago(500), ...over });

test("#743 (1) POSITIVE CONTROL: an idle holder on a RED pull request that declared `waiting-review` is nudged, naming the failing check; the SAME holder green is still excused", () => {
  const f = onPr(redPr(), { declared: declare("waiting-review") });
  const red = claimReading(f, ctx({ idleSince: ago(11) }));
  assert.deepEqual([red.kind, (red as { idle?: boolean }).idle], ["nudge", true]);
  const [order] = claimStalledOrders([{ facts: f, reading: red }] as never, NOW);
  assert.match(order.prompt, /ITS PULL REQUEST IS RED: #2968 \(`gate`\)/);
  assert.match(order.prompt, /FIX THE RED CHECK NOW/);
  assert.match(order.prompt, /NUDGE 1 OF 3/);
  assert.doesNotMatch(order.prompt, /YOU DECLARED/, "the text is the red check's, not the declaration's");
  const green = claimReading(onPr(redPr(GREEN), { declared: declare("waiting-review") }), ctx({ idleSince: ago(11) }));
  assert.deepEqual(green, { kind: "pr-owned" }, "NEGATIVE CONTROL: green checks, the same declaration: excused as before");
});

test("#743 (1) `waiting-ci` is voided by a red check too, `done` is not, and a declaration is read only for the pull request's own red", () => {
  for (const state of ["waiting-ci", "waiting-review"]) {
    assert.equal(claimReading(onPr(redPr(), { declared: declare(state) }), ctx({ idleSince: ago(11) })).kind, "nudge", state);
    assert.equal(claimReading(onPr(redPr(GREEN), { declared: declare(state) }), ctx({ idleSince: ago(11) })).kind, "pr-owned", `${state}, green`);
  }
  assert.equal(claimReading(onPr(redPr(), { declared: declare("done") }), ctx({ idleSince: ago(11) })).kind, "pr-owned", "`done` lapses on its own facts, not on a red check");
});

test("#743 (1) the clock for a red pull request is M (10 minutes) with or without a declaration, and N (30) for the green one; a young red pull request has no grace", () => {
  assert.equal(STOPPED_CLAIMANT_MS / MIN, 10);
  assert.equal(claimReading(onPr(redPr(), { declared: declare("waiting-ci") }), ctx({ idleSince: ago(5) })).kind, "idle-watch", "5 minutes idle: not yet");
  // no declaration read at all (the gate could not ask): the older N was 30
  assert.equal(claimReading(onPr(redPr()), ctx({ idleSince: ago(11) })).kind, "nudge", "red: told at 11 minutes");
  assert.equal(claimReading(onPr(redPr(GREEN)), ctx({ idleSince: ago(11) })).kind, "pr-owned", "CONTROL (agent-org#805): the same holder green is never a nudge, whatever its idle time");
  assert.equal(idleLimitMs({ built: true, prs: withRedChecks([redPr()]) as never }), STOPPED_CLAIMANT_MS);
  assert.equal(idleLimitMs({ built: true, prs: withRedChecks([redPr(GREEN)]) as never }), IDLE_CLAIMANT_MS);
  assert.equal(idleLimitMs({ prs: withRedChecks([redPr()]) as never }), IDLE_CLAIMANT_MS, "a caller that does not say `built` keeps N, as for the stopped clock");
  const young = { createdAt: new Date(ago(5)).toISOString() };
  assert.equal(claimReading(onPr(redPr(RED, young)), ctx({ idleSince: ago(11) })).kind, "nudge", "a red pull request opened 5 minutes ago is no review the org owes");
  assert.equal(claimReading(onPr(redPr(GREEN, young)), ctx({ idleSince: ago(50) })).kind, "pr-owned", "CONTROL: a young GREEN one is, as #4017 ruled");
});

test("#743 (1) what a red check does NOT void: a pull request's own `awaiting-evidence` label, a row's wait, and a red that is only a hold's own jobs", () => {
  const evidence = redPr(RED, { labels: [{ name: EVIDENCE_LABEL }] });
  assert.equal(claimReading(onPr(evidence), ctx({ idleSince: ago(50) })).kind, "pr-owned", "the holder named a wait as a field on the pull request itself");
  assert.equal(claimReading(onPr(redPr(), { waitKind: "not-before" }), ctx({ idleSince: ago(50) })).kind, "pr-owned", "and a row's field");
  const held = redPr(RED, { labels: [{ name: `${HOLD_LABEL_PREFIX}worker-9` }] });
  assert.deepEqual(redOwnPrs(withRedChecks([held]) as never), [], "`gate` red under a hold is the hold speaking (red-pr.ts)");
  assert.deepEqual(redOwnPrs(withRedChecks([redPr(RED_TS, { labels: held.labels })]) as never), [{ number: 2968, repoKey: undefined, checks: ["ts"] }], "CONTROL: `ts` red under the same hold is a breakage");
  assert.deepEqual(redOwnPrs(withRedChecks([redPr(GREEN)]) as never), []);
  assert.deepEqual(redOwnPrs(withRedChecks([{ number: 1 }, undefined as never])), [], "no rollup on the pull request is not red");
});

test("#743 (1) ONE DECIDER, NO CYCLE: `idle-claimant.ts` imports neither `red-pr.ts` nor `pr-hold-state.ts`, and the red it reads is `brokenChecks`' answer, derived by `claim-stall.ts`", () => {
  // the review of #1151: `idle-claimant.ts` -> `red-pr.ts` -> `pr-hold-state.ts` -> `idle-claimant.ts` failed at the top of the file under `rstest`; and
  // `org-health.test.ts` (#2956) fails a second list of red conclusions in this file, so the answer is handed in, as `checksPending` is.
  const source = readFileSync(new URL("../idle-claimant.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  for (const reaching of ["./red-pr.ts", "./pr-hold-state.ts"]) assert.ok(!imports.includes(reaching), `idle-claimant.ts must not import ${reaching}`);
  const running = [...RED_TS, { name: "docs", status: "IN_PROGRESS", ...CHECK, completedAt: "0001-01-01T00:00:00Z" }];
  const rerun = [...RED_TS, { name: "ts", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-02T11:20:00Z", completedAt: "2026-10-02T11:30:00Z" }];
  const timedOut = [{ name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT", ...CHECK }, { name: "gate", status: "COMPLETED", conclusion: "CANCELLED", ...CHECK }];
  const hold = [{ name: `${HOLD_PREFIX}worker-9` }];
  const prs = [redPr(RED), redPr(RED_TS), redPr(GREEN), redPr(running), redPr(rerun), redPr(timedOut), redPr(RED_TS, { labels: hold }), redPr(RED, { labels: [`${HOLD_PREFIX}worker-9`] }), redPr(timedOut, { labels: hold })];
  const answers = prs.map((pr) => {
    const expected = [...new Set(brokenChecks(pr as never).map((c) => c.name))];
    assert.deepEqual(withRedChecks([pr])[0].failingChecks, expected, `the names red-pr.ts's brokenChecks finds, for ${JSON.stringify(pr.statusCheckRollup.map((c: any) => `${c.name}:${c.conclusion}`))} ${JSON.stringify(pr.labels)}`);
    assert.deepEqual(redOwnPrs(withRedChecks([pr]) as never).flatMap((r) => r.checks), expected);
    return expected.length;
  });
  assert.ok(answers.some((n) => n > 0) && answers.some((n) => n === 0), "CONTROL: the fixtures are not all one answer");
  // a caller that hands over no `failingChecks` (`org-health.ts`, `idle-claim-incident.ts`) reads the pull request as not red, as it did before #743
  assert.deepEqual(redOwnPrs([redPr(RED)] as never), []);
  assert.equal(idleLimitMs({ built: true, prs: [redPr(RED)] as never }), IDLE_CLAIMANT_MS);
});

test("#743 (1) with NO declaration read, a red check is not excused by a reviewer's pane, an approval or a check still running either -- and green is, as #2999 ruled", () => {
  const reviewer = listing("idle", [{ label: "reviewer-2968", status: "working" }]);
  const oneRunning = [...RED, { name: "ts", status: "IN_PROGRESS", ...CHECK, completedAt: "0001-01-01T00:00:00Z" }];
  const cases: [string, object, object][] = [
    ["a reviewer's pane", redPr(), { agents: reviewer }],
    ["an approval", redPr(RED, { reviewDecision: "APPROVED" }), {}],
    ["another check still running", redPr(oneRunning, { checksPending: true }), {}],
  ];
  for (const [what, pr, more] of cases) {
    assert.equal(claimReading(onPr(pr), ctx({ idleSince: ago(11), ...more })).kind, "nudge", `${what}: the failure is the holder's to fix`);
  }
  assert.equal(claimReading(onPr(redPr(GREEN)), ctx({ idleSince: ago(50), agents: reviewer })).kind, "pr-owned", "CONTROL: green with the same reviewer is the wait it always was");
  assert.equal(claimReading(onPr(redPr(GREEN, { reviewDecision: "APPROVED" })), ctx({ idleSince: ago(50) })).kind, "pr-owned", "and green and approved is the queue's");
});

test("#743 (2) a holder with NO pull request is not counted: the same remembered nudge, idle again, stays `nudged` with `idleAgain` (#860) and is never re-nudged", () => {
  const noPr = facts({ claimedAt: ago(60) });
  const told = { nudgedAt: ago(40), deliveredAt: ago(32), idle: true };
  const held = claimReading(noPr, ctx({ nudge: told, idleSince: ago(35) })) as { kind: string; idleAgain?: boolean; count?: number };
  assert.deepEqual([held.kind, held.idleAgain, held.count], ["nudged", true, undefined]);
  const counted = claimReading(onPr(redPr(), { claimedAt: ago(60) }), ctx({ nudge: told, idleSince: ago(35) })) as typeof held;
  assert.deepEqual([counted.kind, counted.count], ["nudge", 2], "CONTROL: the same memory on a RED holder with a pull request open is the second nudge (the red exception)");
  assert.equal(claimReading(onPr(redPr(GREEN), { claimedAt: ago(60) }), ctx({ nudge: told, idleSince: ago(35) })).kind, "pr-owned", "agent-org#805: a GREEN holder with the same memory is pr-owned");
});

test("#743 (2) the THIRD unanswered nudge releases a holder with a pull request open, and the second does not -- the pull request is left as it is", () => {
  const f = onPr(redPr());
  const told = (count?: number) => ({ nudgedAt: ago(100), deliveredAt: ago(90), idle: true, ...(count === undefined ? {} : { count }) });
  const first = claimReading(f, ctx({ nudge: told() })) as { kind: string; count?: number; unanswered?: number; idleMs: number };
  assert.deepEqual([first.kind, first.count, first.unanswered], ["nudge", 2, ago(100)], "one unanswered nudge: the second is sent, and carries the first");
  const second = claimReading(f, ctx({ nudge: told(2) })) as typeof first;
  assert.deepEqual([second.kind, second.count, second.unanswered], ["nudge", 3, ago(100)], "TWO unanswered: the third is sent, NOT a release");
  const third = claimReading(f, ctx({ nudge: told(MAX_UNANSWERED_NUDGES) })) as { kind: string; why: string; count: number; openPrs?: number[]; nudgedAt: number; idleSince: number };
  assert.deepEqual([third.kind, third.why, third.count, third.openPrs, third.nudgedAt, third.idleSince], ["release", "stalled", 3, undefined, ago(100), ago(50)]);
  const [release] = claimStalledOrders([{ facts: f, reading: third }] as never, NOW) as { prompt: string; release: Record<string, unknown> }[];
  assert.deepEqual([release.release.why, release.release.nudges, release.release.answer, release.release.openPrs], ["stalled", 3, undefined, undefined],
    "the SAME path as the no-PR release: no `answer`, so the row goes back to `ready`; and no `openPrs`, so the pull request is not what the performer holds the row for");
  assert.match(release.prompt, /3 nudges went unanswered/);
  assert.match(release.prompt, /open pull request is left as it is/);
});

test("#743 (2) CONTROLS: an undelivered nudge, one delivered inside the period, and a holder back at work are not unanswered", () => {
  const f = onPr(redPr());
  const at = (over: object) => claimReading(f, ctx({ nudge: { nudgedAt: ago(100), deliveredAt: ago(90), idle: true, count: 3, ...over } }));
  assert.equal(at({ deliveredAt: null }).kind, "nudged", "never delivered: the holder was not told, so nothing is unanswered");
  assert.equal(at({ deliveredAt: ago(5) }).kind, "nudged", "delivered 5 minutes ago: not yet a full idle period after it");
  assert.equal(at({}).kind, "release", "and the same nudge delivered 90 minutes ago, idle since, is the third unanswered");
  const working = claimReading(f, ctx({ nudge: { nudgedAt: ago(100), deliveredAt: ago(90), idle: true, count: 3 }, agents: listing("working") }));
  assert.equal(working.kind, "nudged", "a nudge wakes its holder: `working` is read as still inside the nudge, the count is kept and nothing is released on a working holder");
  assert.deepEqual(nextStallState({}, [{ facts: f, reading: working }] as never, NOW), { 2999: { session: "worker-9", nudgedAt: ago(100), idle: true, nudges: 3 } });
});

test("#743 (2) a nudge ANSWERED by a commit, a push, a new pull request or a new claim resets the count; a comment or a changed file does not", () => {
  const told = { nudgedAt: ago(100), deliveredAt: ago(90), idle: true, count: 3 };
  const reading = (f: Parameters<typeof claimReading>[0], over: object = {}) => claimReading(f, ctx({ nudge: told, ...over }));
  const stalled = reading(onPr(redPr()));
  assert.equal(stalled.kind, "release", "the unanswered third, as above: the control for every reset below");
  for (const [what, f] of [
    ["a commit", onPr(redPr(), { commit: () => ago(20) })],
    ["a push", onPr(redPr(), { push: () => ago(20) })],
    ["a pull request opened", onPr(redPr(RED, { createdAt: new Date(ago(20)).toISOString() }))],
    ["a new claim", onPr(redPr(), { claimedAt: ago(20) })],
  ] as const) {
    const again = reading(f) as { kind: string; count?: number; unanswered?: number };
    assert.deepEqual([what, again.kind, again.count, again.unanswered], [what, "nudge", undefined, undefined], `${what}: a FIRST reading again, numbered 1`);
  }
  assert.equal(reading(onPr(redPr(), { commit: () => ago(20) }), { agents: listing("working") }).kind, "pr-owned", "back at work after the commit: the memory is dropped");
  assert.equal(reading(onPr(redPr(), { comment: ago(20) })).kind, "release", "a ROW COMMENT after the nudge is not progress: it was the clock's move, not the stall's end");
  assert.equal(reading(onPr(redPr(), { file: () => ago(20) })).kind, "release", "nor is a changed file");
  assert.equal(reading(onPr(redPr(), { commit: () => ago(150) })).kind, "release", "a commit BEFORE the nudge is not an answer to it");
});

test("#743 (2) the count is kept in the memory (absent for the first), rides the order, and files one failure event per unanswered nudge", () => {
  const f = onPr(redPr());
  const first = claimReading(f, ctx({ idleSince: ago(50) }));
  assert.deepEqual(nextStallState({}, [{ facts: f, reading: first }] as never, NOW), { 2999: { session: "worker-9", nudgedAt: NOW, idle: true } }, "the first nudge writes what it always wrote");
  const second = claimReading(f, ctx({ nudge: { nudgedAt: ago(100), deliveredAt: ago(90), idle: true } }));
  assert.deepEqual(nextStallState({}, [{ facts: f, reading: second }] as never, NOW), { 2999: { session: "worker-9", nudgedAt: NOW, idle: true, nudges: 2 } });
  const [order] = claimStalledOrders([{ facts: f, reading: second }] as never, NOW);
  assert.equal(order.causeKey, nudgeKey("worker-9", 2999, NOW), "a NEW key: the previous nudge's delivery must not read as this one's");
  assert.notEqual(order.causeKey, nudgeKey("worker-9", 2999, ago(100)));
  assert.match(order.prompt, /NUDGE 2 OF 3/);
  assert.deepEqual(stalledNudgeEvents([{ facts: f, reading: second }] as never, NOW).map((e) => e.ref), [`worker-9/#2999/${ago(100)}`], "the nudge it superseded was unanswered");
  assert.deepEqual(stalledNudgeEvents([{ facts: f, reading: first }] as never, NOW), [], "CONTROL: a first nudge is the guard working, not an event (#4826)");
  const released = claimReading(f, ctx({ nudge: { nudgedAt: ago(40), deliveredAt: ago(30), idle: true, count: 3 } }));
  assert.equal(released.kind, "release");
  assert.deepEqual(nextStallState({}, [{ facts: f, reading: released }] as never, NOW), { 2999: { session: "worker-9", nudgedAt: ago(40), idle: true, nudges: 3, idleSince: ago(50) } },
    "a release not yet performed keeps what it needs to be read as a release again next tick");
});

test("#743 (2) a holder with a RED pull request is counted, a GREEN one is not nudged at all (agent-org#805); a holder with NO pull request is told nothing new", () => {
  const green = onPr(redPr(GREEN));
  assert.deepEqual(claimStalledOrders([{ facts: green, reading: claimReading(green, ctx()) }] as never, NOW), [], "CONTROL: a green holder, idle, gets no order");
  const red = onPr(redPr());
  const [order] = claimStalledOrders([{ facts: red, reading: claimReading(red, ctx()) }] as never, NOW);
  assert.match(order.prompt, /RED: /, "the red-check nudge is the exception the ruling names");
  const none = facts();
  const [plain] = claimStalledOrders([{ facts: none, reading: claimReading(none, ctx()) }] as never, NOW);
  assert.doesNotMatch(plain.prompt, /NUDGE \d OF/);
  assert.equal(plain.prompt, stoppedNudgePrompt({ row: 2999, branch: "agent/x-2999", idleMinutes: 50, releaseMinutes: 120, canRelease: true }), "byte-identical to today's");
  assert.match(redCheckNudgePrompt({ row: 5, branch: null, idleMinutes: 10, red: [{ number: 38, repoKey: "agent-org", checks: ["gate", "ts"] }], nudge: 3 }),
    /RED: agent-org#38 \(`gate`, `ts`\)/, "a pull request in another tracked repository is named by its key");
});

// --- the gate wiring: one decider for "has a wait field" ----------------------------------------------------------------------------------

const BRANCH = "agent/x-2999";
const claimRow = (body: string, labels: string[] = []) => ({ number: 2999, title: "row", body, blockedBy: { nodes: [] },
  labels: ["in-progress", "session:worker-9", ...labels].map((name) => ({ name })) });
const claimComment = { body: claimRecordComment({ session: "worker-9", branch: BRANCH, worktree: "../wt-2999" }), createdAt: new Date(ago(200)).toISOString(),
  author: { login: "a11ign-ai-workers" } };
const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

function gateTick(row: object, { prs = [] as object[], agents = listing("idle"), memory = { 2999: { session: "worker-9", idleSince: ago(50) } } as Record<string, unknown>, stateDir = "/state" } = {}) {
  return claimStallTick({ rows: [row], claimedComments: [{ number: 2999, comments: [claimComment] }], openPrs: prs, mergedPrs: null, io: noGit,
    repo: "/repo", now: NOW, restartAt: null, agents, stateDir, ledger: () => "", log: () => undefined,
    read: () => JSON.parse(JSON.stringify(memory)), write: () => undefined } as never) as { prompt: string; cause: string; release?: { why: string } }[];
}

/** #460: `gateTick` over a state directory in which `worker-9` declared `declaration` 100 minutes ago (the claim is 200 old, so it is fresh). */
function declaredTick(row: object, declaration: Omit<Declaration, "session" | "at">, options: Omit<Parameters<typeof gateTick>[1], "stateDir"> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "idle-claimant-declared-"));
  try {
    writeDeclaration(`${dir}/${WORKER_STATE_DIR}`, { session: "worker-9", at: ago(100), ...declaration });
    return gateTick(row, { ...options, stateDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** the orders that ASK the holder something: #4637 releases a holder holding nothing on a declared wait, and a release is not a nudge */
const nudgesOf = (orders: { release?: unknown }[]) => orders.filter((o) => o.release === undefined);

test("#2999 through the gate: a row carrying a future `Not-before:` or `needs:chairman` is not nudged, and the same row without one IS", () => {
  assert.equal(gateTick(claimRow("")).length, 1, "the control: an idle holder with no field is nudged");
  assert.equal(nudgesOf(gateTick(claimRow("Not-before: 2099-01-01"))).length, 0);
  assert.equal(nudgesOf(gateTick(claimRow("", ["needs:chairman"]))).length, 0);
  assert.equal(nudgesOf(gateTick(claimRow("", ["answer:product-manager"]))).length, 0, "an answer owed by ANOTHER session is a wait");
  // #4637: this holder holds nothing (`noGit` reads a clean, absent tree), so the same three waits RELEASE it instead of leaving it holding a slot
  for (const wait of [claimRow("Not-before: 2099-01-01"), claimRow("", ["needs:chairman"]), claimRow("", ["answer:product-manager"])]) {
    assert.deepEqual(gateTick(wait).map((o) => o.release?.why), ["wait"]);
  }
  assert.equal(gateTick(claimRow("", ["answer:worker-9"])).length, 1, "an answer owed BY THE HOLDER is the row waiting on the holder, which `declaredWait` already refuses to read as one");
});

test("#2999 through the gate (agent-org#805): an open PR is never nudged for its checks, the newest run or not; with no open PR the declared wait lapses and the holder is nudged", () => {
  const stale = { name: "gate", status: "IN_PROGRESS", startedAt: "2026-10-02T10:00:00Z", completedAt: "0001-01-01T00:00:00Z" };
  const done = { name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-02T10:05:00Z", completedAt: "2026-10-02T10:09:00Z" };
  const newer = { name: "gate", status: "IN_PROGRESS", startedAt: "2026-10-02T10:20:00Z", completedAt: "0001-01-01T00:00:00Z" };
  const pr = (statusCheckRollup: object[]) => ({ number: 2968, headRefName: BRANCH, reviewDecision: "REVIEW_REQUIRED", labels: [], statusCheckRollup });
  const waitingCi = { state: "waiting-ci" as const, pr: { number: 2968 } };
  // #460: a pending check is a wait only for a holder that DECLARED `waiting-ci` (the declaration is what is read; the check is what must still be true)
  assert.equal(declaredTick(claimRow(""), waitingCi, { prs: [pr([stale, done])] }).length, 0, "agent-org#805: an open PR is never nudged, whichever run is the newest");
  assert.equal(declaredTick(claimRow(""), waitingCi, { prs: [pr([done, newer])] }).length, 0, "agent-org#805: the pending run NEWER than the completed one does not make it a nudge either");
  assert.equal(declaredTick(claimRow(""), waitingCi, { prs: [] }).length, 1, "CONTROL: with no open PR the declared wait has lapsed and the holder is nudged");
  assert.equal(gateTick(claimRow(""), { prs: [pr([done, newer])] }).length, 0, "agent-org#805: and the same open PR with NOTHING declared is not nudged");
});

test("#2999 through the gate (agent-org#805): an open PR is never nudged, declared or not, reviewer or not; with no PR the undeclared holder is nudged; `claimFactsFrom` carries the PR", () => {
  const pr = { number: 2968, headRefName: BRANCH, reviewDecision: "REVIEW_REQUIRED", labels: [], checksPending: false };
  const reviewer = listing("idle", [{ label: "reviewer-2968", status: "working" }]);
  assert.equal(gateTick(claimRow(""), { prs: [pr] }).length, 0, "agent-org#805: an open PR is never a nudge, declared or not");
  assert.equal(gateTick(claimRow(""), { prs: [pr], agents: reviewer }).length, 0, "and a reviewer's pane changes nothing: the open PR is the holder's");
  assert.equal(gateTick(claimRow(""), { prs: [] }).length, 1, "CONTROL: with NO open pull request the undeclared holder is nudged");
  assert.equal(declaredTick(claimRow(""), { state: "waiting-review", pr: { number: 2968 } }, { prs: [pr], agents: reviewer }).length, 0, "declared, the same holder is waiting");
  assert.equal(declaredTick(claimRow(""), { state: "waiting-review", pr: { number: 2969 } }, { prs: [pr] }).length, 0, "agent-org#805: a declaration for ANOTHER pull request does not make this one a nudge either");
  const built = claimFactsFrom({ row: 2999, session: "worker-9", waiting: null, blockedBy: [], comments: [claimComment], openPrs: [pr], mergedPrs: null,
    repo: "/repo", waitKind: "not-before" }, noGit as never) as { ownPrs: unknown[]; waitKind: string };
  assert.deepEqual(built.ownPrs, [pr]);
  assert.equal(built.waitKind, "not-before");
});
