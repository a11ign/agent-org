// a11ign/a11ign#3511 (slice 4 of #3494): THE WATERFALL -- `trace -- <row>` prints a row's eight phases: where the wall-clock went, how much of it a session was WORKING and how much
// it was WAITING (and on what), what each phase cost, and every repeat, in the phase it happened in.
//
// A PURE FUNCTION from one row's events (what `eventsForRow` returns) to phases. It opens no file and calls no `gh`; `trace.mjs` hands it the events and the time of the reading.
//
// THE PHASES, and what bounds each (`product-manager`'s definition on #3511):
//   spec    row filed -> row claimed             claim   claimed -> the claimant's first turn on it    build  that turn -> the pull request opened
//   verify  opened -> ready_for_review           review  each push or ready -> the review that follows it
//   CI      each head, and each WAVE of checks started again at it -> its last check-run done   queue   first added_to_merge_queue -> merged (an ejection is a repeat, not an end)   merge  merged -> closed
// They OVERLAP (CI runs while a review waits; a draft is approved before it is marked ready), so the phase wall-clocks add to more than the row's. EXCLUSIVE counts each moment once, in
// the phase that began last and is still running, so the exclusive times, and the dollars of the turns that ended in each phase, add up to the whole -- which `aggregate.mjs` relies on.
//
// EVERY MOMENT OF A RUN IS ONE OF THREE THINGS, and never two:
//   WORKING      a model turn was running (the union of the turns' spans: two sessions at once are one stretch of wall-clock). A span is the turn's `wallClockMs` before its end, which the store
//                INFERS: the model's own time, from the record the harness stamped after the tool finished. MEASURED on worker-3641 (a11ign/a11ign#3641, #3669): five gaps of 365-524 s
//                between consecutive turns carry spans of 0-4 s, so a long tool call is in NO turn's span. A turn with no `wallClockMs` has a span of nothing: its tokens and dollars count, its time does not.
//   WAITING      something RECORDED was in progress: a deferral span, a hold label, an order not yet delivered, a queue entry, an ejection, CI running, a review not yet posted, a tool call running (the turn's own `toolMs`, claimed last). Each is named.
//                One wait is INFERRED and marked so, for the stretch between an approval and the ready mark of a draft (`approvedDraftSource`), with the records it was read from.
//   unexplained  nothing was recorded. It is printed as such and is NEVER folded into WORKING (the acceptance's positive control).
// A moment is given to the first of these that claims it, in that order, so the three add up to the wall-clock exactly.
//
// WHAT THE STORE DOES NOT SAY, and the waterfall does not guess: whether a pull request was opened as a draft when its `opened` record has `draft: null` or no `draft` (written before
// the field, or the pull object was not read: a pull request with no `ready_for_review` then reads as a verify phase that says it does not know); and the push time of a head (`head_moved.at` is the COMMIT's date).
import { ANSWER_PREFIX } from "../project-vocabulary.ts";

import type { TraceEvent } from "./store.ts";

/** from and to, in ms */
type Span = [number, number];
type WaitSource = { source: string; label: string; inferred: boolean; evidence: string[]; spans: Span[] };
export type Wait = { source: string; label: string; inferred: boolean; evidence: string[]; ms: number };
/** a run before it is classified: `to` is `null` while it is open */
export type Cut = { phase: string; label: string; from: number; to: number | null; state: "ended" | "open" | "cut"; note?: string };
export type Spend = { turns: number; priced: number; unpriced: number; dollars: number; tokens: number };
export type Repeat = { kind: string; at: number; phase: string; summary: string; evidence: string[] };

export const PHASES = ["spec", "claim", "build", "verify", "review", "CI", "queue", "merge"];
/** The pseudo-phase for time and turns no phase covers. */
export const BETWEEN = "between";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SHORT_SHA = 7;
const WAVE_NAMES = 4; // check-run names listed before "and n more"
const COST_DECIMALS = 4;
const DEFERRED_MARK = "@deferred";
const WAVE_GAP_MS = 60 * MS_PER_SECOND; // a check-run starting within a minute of the last one finishing is a job that needed it, not a retrigger

export const DEFINITIONS = [
  "WATERFALL (#3511): the eight phases of a row, from its events. spec: filed -> claimed. claim: claimed -> the claimant's first turn on it. build: that turn -> the pull request opened. verify: opened -> ready_for_review (a pull request opened ready, which has no such event, has a verify of nothing, said so only when `opened.draft` is false; with `draft` null or absent the store does not say whether it began as a draft). review: each push or ready -> the review that follows it (a ready mark on a head already reviewed starts none). CI: each head -> its last check-run completing, once per WAVE of checks (a check-run starting more than a minute after all the earlier ones finished starts a new wave, as the ready mark does; two overlapping runs of one name are two triggers of one wave). A head's time is its commit's date. queue: the first queue entry -> merged (an ejection is a repeat, not an end). merge: merged -> the row closed.",
  "A phase with a start and no end is OPEN and prints so, to the time of the reading, and is never printed as ended. One that started and was never ended before the pull request or row CLOSED is CUT at the close. A phase with no start record is `not held`, and one never reached is `not reached`, each with its reason.",
  "WORKING + WAITING + unexplained = the wall-clock of a run, exactly. WORKING is the union of the turns' spans (a turn's span is its `wallClockMs` before its end, inferred by the store; a turn with none adds tokens and dollars and no time). WAITING is a RECORD: a deferral span, a hold label, an order delivered after it was typed, a merge-queue entry, an ejection, CI running, a review not yet posted, a tool call running (the stretch before a turn that its own `toolMs` measures), each named. unexplained is a gap with no record, and is never WORKING.",
  "INFERRED (marked): a draft APPROVED and not yet marked ready is waiting on whoever the ledger's orders about it were delivered to; the review, those orders and that session's turns in the gap are named as the evidence.",
  "PHASES OVERLAP, so their wall-clocks add to more than the row's. EXCLUSIVE counts each moment once, in the latest-started phase running at it (time no phase covers is `between`), and the dollars and tokens of a turn are in the phase its END falls in, so both add up to the row's.",
  "DOLLARS are the store's own `costUsd` per turn; a turn with a `null` cost is counted UNPRICED, never as zero, and a phase with one is a floor.",
  "REPEATS, flagged in the phase they happened in, with their evidence: a second review at the same head (review), a re-queue at the same head (queue), a wake whose session and ledger key (without `@deferred`) were delivered before, a CI re-run at the same head: a later wave of checks (CI), and a compaction.",
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Spans

export const lengthOf = (spans: Span[]) => spans.reduce((sum, [from, to]) => sum + (to - from), 0);

/** Sorted, overlapping and touching spans joined, empty ones dropped. */
function normalize(spans: Span[]): Span[] {
  const joined: Span[] = [];
  for (const [from, to] of spans.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = joined.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
}

/** The parts of `a` that are in `b`. Both are normalized. */
function intersect(a: Span[], b: Span[]): Span[] {
  const both: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const from = Math.max(a[i][0], b[j][0]);
    const to = Math.min(a[i][1], b[j][1]);
    if (to > from) both.push([from, to]);
    if (a[i][1] < b[j][1]) i += 1;
    else j += 1;
  }
  return both;
}

/** The parts of `a` that are not in `b`. Both are normalized. */
function minus(a: Span[], b: Span[]): Span[] {
  const left: Span[] = [];
  for (const [start, to] of a) {
    let from = start;
    for (const [cutFrom, cutTo] of b) {
      if (cutTo <= from || cutFrom >= to) continue;
      if (cutFrom > from) left.push([from, cutFrom]);
      from = Math.max(from, cutTo);
    }
    if (from < to) left.push([from, to]);
  }
  return left;
}

/** The span of one turn: its wall-clock before its end, or nothing when the store has none. */
const turnSpan = (turn: TraceEvent): Span => [turn.at - Math.max(0, turn.wallClockMs ?? 0), turn.at];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Reading the events

const byTime = (a: TraceEvent, b: TraceEvent) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id);
const short = (sha: string | undefined) => (sha ?? "?").slice(0, SHORT_SHA);

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM:SS".length).replace("T", " ");

export function duration(ms: number) {
  const seconds = Math.round(ms / MS_PER_SECOND);
  if (seconds === 0 && ms > 0) return "<1s";
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (minutes === 0) return `${seconds}s`;
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m${pad(seconds % SECONDS_PER_MINUTE)}s`;
  return `${Math.floor(minutes / MINUTES_PER_HOUR)}h${pad(minutes % MINUTES_PER_HOUR)}m${pad(seconds % SECONDS_PER_MINUTE)}s`;
}

type Pull = { number: number; opened?: TraceEvent; ready?: TraceEvent; heads: TraceEvent[]; reviews: TraceEvent[]; ci: TraceEvent[]; adds: TraceEvent[]; removes: TraceEvent[];
  merged?: TraceEvent; closed?: TraceEvent };

/**
 * Everything one pull request's events say, in the order the waterfall needs them. A check-run is in the store once per STATUS it was seen in, so a run seen going and seen done is
 * one run: the copy with a completion wins.
 * `events`: the github events of this pull request, in time order
 */
function pullOf(number: number, events: TraceEvent[]): Pull {
  const of = (kind: string) => events.filter((event) => event.kind === kind);
  const runs: Map<string, TraceEvent> = new Map();
  for (const run of of("ci_run")) {
    const key = `${run.headSha}\t${run.name}\t${run.startedAt}`;
    if (!runs.has(key) || (run.completedAt !== null && run.completedAt !== undefined)) runs.set(key, run);
  }
  return {
    number, opened: of("opened")[0], ready: of("ready_for_review")[0], heads: of("head_moved"), reviews: of("reviewed"), adds: of("added_to_merge_queue"),
    removes: of("removed_from_merge_queue"), ci: [...runs.values()].sort((a, b) => (a.startedAt ?? a.at) - (b.startedAt ?? b.at)), merged: of("merged")[0], closed: of("closed")[0],
  };
}

type Context = { events: TraceEvent[]; turns: TraceEvent[]; wakes: TraceEvent[]; now: number; stop: number | null; filed?: TraceEvent; claim?: TraceEvent;
  pulls: Pull[]; rowClosed: TraceEvent[] };

function contextOf(events: TraceEvent[], now: number): Context {
  const sorted = events.filter((event) => event.kind !== "gh_call").sort(byTime);
  const github = sorted.filter((event) => event.source === "github");
  const numbers = [...new Set(github.flatMap((event) => (typeof event.pr === "number" ? [event.pr] : [])))].sort((a, b) => a - b);
  const closes = github.filter((event) => event.kind === "closed");
  return {
    events: sorted, now, turns: sorted.filter((event) => event.kind === "turn"), wakes: sorted.filter((event) => event.kind === "wake"),
    filed: github.find((event) => event.kind === "filed"), claim: github.find((event) => event.kind === "claimed"),
    pulls: numbers.map((number) => pullOf(number, github.filter((event) => event.pr === number))),
    rowClosed: closes.filter((event) => event.row !== null), stop: closes.length === 0 ? null : Math.max(...closes.map((event) => event.at)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The phases' bounds

/**
 * A run. `to` null is open: with no end record it is OPEN, unless the pull request or row closed after it began, when it is CUT there. An end before its start (clocks of two sources
 * that disagree) is clamped to the start and says so.
 */
function cut(ctx: Context, { phase, label, from, to, note }: { phase: string; label: string; from: number; to: number | null; note?: string; }): Cut {
  const clamped = to !== null && to < from;
  const noted = [note, clamped ? `ended ${duration(from - (to as number))} before it began by the clocks of two sources: clamped to nothing` : undefined].filter(Boolean).join("; ");
  const rest = noted === "" ? {} : { note: noted };
  if (to !== null) return { phase, label, from, to: Math.max(from, to), state: "ended", ...rest };
  if (ctx.stop !== null && ctx.stop >= from) return { phase, label, from, to: ctx.stop, state: "cut", ...rest };
  return { phase, label, from, to: null, state: "open", ...rest };
}

type Built = { runs: Cut[]; why: string | null };
const without = (why: string): Built => ({ runs: [], why });

function specRuns(ctx: Context): Built {
  if (!ctx.filed) return without("not held: no `filed` event of a row in the store (a trace of a pull request that closes no row has none)");
  return { runs: [cut(ctx, { phase: "spec", label: "row filed -> claimed", from: ctx.filed.at, to: ctx.claim?.at ?? null })], why: null };
}

/** The claimant's first turn on the row at or after the claim, and when it began: not before the claim (a claim made inside the turn begins the turn's work, not the wait). */
function claimantStart(ctx: Context) {
  const claim = ctx.claim;
  if (!claim?.claimant) return null;
  const first = ctx.turns.find((turn) => turn.session === claim.claimant && turn.at >= claim.at);
  return first ? { turn: first, began: Math.max(claim.at, turnSpan(first)[0]) } : null;
}

function claimRuns(ctx: Context): Built {
  if (!ctx.claim) return without("not held: no claim record in the store");
  const start = claimantStart(ctx);
  const label = `claimed by ${ctx.claim.claimant} -> its first turn`;
  return { runs: [cut(ctx, { phase: "claim", label, from: ctx.claim.at, to: start?.began ?? null })], why: null };
}

function buildRuns(ctx: Context): Built {
  const start = claimantStart(ctx);
  const opened = ctx.pulls.flatMap((pull) => (pull.opened ? [pull.opened] : [])).sort(byTime)[0];
  if (!start) return without(ctx.claim ? `not held: no turn of ${ctx.claim.claimant} on the row at or after its claim is in the store` : "not held: no claim record, so no claimant whose first turn could begin it");
  return { runs: [cut(ctx, { phase: "build", label: `${ctx.claim?.claimant}'s first turn -> pull request opened`, from: start.began, to: opened?.at ?? null })], why: null };
}

/** Whether the pull request got as far as a queue entry or a merge, which a draft cannot. */
const wasReady = (pull: Pull) => pull.adds.length > 0 || pull.merged !== undefined;

/**
 * The verify run of a pull request that has no `ready_for_review` event, read from what `opened.draft` says (`null`, or absent from a record written before the field, is
 * "the store does not say"; only `false` is "opened ready").
 */
function unmarkedVerify(ctx: Context, pull: Pull, label: string) {
  const opened = (pull.opened as TraceEvent);
  const draft = (opened as TraceEvent & { draft?: boolean | null }).draft;
  const instant = (note: string) => [cut(ctx, { phase: "verify", label, from: opened.at, to: opened.at, note })];
  if (draft === false) return instant("opened ready (draft: false), so no ready_for_review event and no draft stage");
  if (draft === true && wasReady(pull)) return instant("opened as a draft and then queued or merged, but the store holds no ready_for_review event: the end of the draft stage is not held");
  if (draft === true) return [cut(ctx, { phase: "verify", label, from: opened.at, to: null, note: "opened as a draft, no ready_for_review yet: still a draft" })];
  if (wasReady(pull)) return instant("no ready_for_review event, and it was queued or merged: the store's `opened` does not say whether it began as a draft");
  return [cut(ctx, { phase: "verify", label, from: opened.at, to: null, note: "no ready_for_review yet: still a draft, or opened ready (the store's `opened` does not say which)" })];
}

function verifyRun(ctx: Context, pull: Pull, several: boolean) {
  const { opened, ready } = pull;
  if (!opened) return [];
  const label = `${several ? `#${pull.number} ` : ""}opened -> ready_for_review`;
  if (ready) return [cut(ctx, { phase: "verify", label, from: opened.at, to: ready.at })];
  return unmarkedVerify(ctx, pull, label);
}

function verifyRuns(ctx: Context): Built {
  const runs = ctx.pulls.flatMap((pull) => verifyRun(ctx, pull, ctx.pulls.length > 1));
  return runs.length > 0 ? { runs, why: null } : without("not reached: no pull request opened");
}

/**
 * The review rounds of one pull request: a push (the opening, or a head that moved after it) starts one, and the next review of any kind ends it. A ready mark starts one only when
 * the head has not been reviewed since it last moved, so a draft approved and then marked ready is not waiting for a second review. A reviewer reads a settled DRAFT (#3406 was approved
 * as one), so a draft's pushes count.
 */
function reviewRounds(ctx: Context, pull: Pull, several: boolean): Cut[] {
  if (!pull.opened) return [];
  const opened = pull.opened;
  const items = [
    { kind: "push", at: opened.at, what: "opened" }, ...(pull.ready ? [{ kind: "ready-mark", at: pull.ready.at, what: "marked ready" }] : []),
    ...pull.heads.filter((head) => head.at > opened.at).map((head) => ({ kind: "push", at: head.at, what: `push ${short(head.headSha)}` })),
    ...pull.reviews.map((review) => ({ kind: "review", at: review.at, what: "" })),
  ].sort((a, b) => a.at - b.at || Number(a.kind === "review") - Number(b.kind === "review"));
  const rounds: Cut[] = [];
  let pending: { at: number; what: string; } | null = null;
  let unreviewed = true;
  const tag = several ? `#${pull.number} ` : "";
  for (const item of items) {
    if (item.kind === "review") {
      if (pending) rounds.push(cut(ctx, { phase: "review", label: `${tag}${pending.what} -> review`, from: pending.at, to: item.at }));
      pending = null;
      unreviewed = false;
    } else if (item.kind === "push") {
      unreviewed = true;
      pending ??= { at: item.at, what: item.what };
    } else if (unreviewed) pending ??= { at: item.at, what: item.what };
  }
  if (pending) rounds.push(cut(ctx, { phase: "review", label: `${tag}${pending.what} -> review`, from: pending.at, to: null }));
  return rounds;
}

function reviewRuns(ctx: Context): Built {
  const runs = ctx.pulls.flatMap((pull) => reviewRounds(ctx, pull, ctx.pulls.length > 1));
  return runs.length > 0 ? { runs, why: null } : without("not reached: no pull request opened");
}

/** The heads a pull request's CI ran at, first run first. */
const headsRun = (pull: Pull): string[] => [...new Set(pull.ci.flatMap((run) => (run.headSha ? [run.headSha] : [])))];

/**
 * The check-runs of one head in WAVES: a new wave starts when a run begins more than `WAVE_GAP_MS` after every earlier run finished. Two runs of one name that overlap are two
 * triggers of one wave (measured on #3406: two triggers a few seconds apart), not a re-run; a second wave is checks started again, as the ready mark does.
 * `runs`: one head's runs, by start
 */
function wavesOf(runs: TraceEvent[]): TraceEvent[][] {
  const waves: TraceEvent[][] = [];
  let until = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if ((run.startedAt ?? run.at) > until + WAVE_GAP_MS) waves.push([]);
    waves.at(-1)?.push(run);
    until = Math.max(until, run.completedAt ?? Number.POSITIVE_INFINITY);
  }
  return waves;
}

/** Each head's waves, first head first. */
const wavesByHead = (pull: Pull): { sha: string; waves: TraceEvent[][]; }[] => headsRun(pull).map((sha) => ({ sha, waves: wavesOf(pull.ci.filter((run) => run.headSha === sha)) }));

/** When the wave's last check-run completed, or `null` while one is still going. */
const waveEnd = (wave: TraceEvent[]): number | null => (wave.some((run) => run.completedAt === null || run.completedAt === undefined) ? null : Math.max(...wave.map((run) => (run.completedAt as number))));

function ciRounds(ctx: Context, pull: Pull, several: boolean): Cut[] {
  return wavesByHead(pull).flatMap(({ sha, waves }) => waves.map((wave, index) => {
    const committed = pull.heads.find((head) => head.headSha === sha)?.at ?? Number.NEGATIVE_INFINITY;
    const firstStart = Math.min(...wave.map((run) => run.startedAt ?? run.at));
    const from = index === 0 ? Math.min(Math.max(committed, pull.opened?.at ?? firstStart), firstStart) : firstStart;
    const label = `${several ? `#${pull.number} ` : ""}head ${short(sha)}${waves.length > 1 ? `, wave ${index + 1}` : ""} -> its last of ${wave.length} check-runs`;
    return cut(ctx, { phase: "CI", label, from, to: waveEnd(wave) });
  }));
}

function ciRuns(ctx: Context): Built {
  const runs = ctx.pulls.flatMap((pull) => ciRounds(ctx, pull, ctx.pulls.length > 1));
  return runs.length > 0 ? { runs, why: null } : without("not held: no check-run of any head of the pull requests is in the store");
}

function queueRuns(ctx: Context): Built {
  const runs = ctx.pulls.flatMap((pull) => (pull.adds.length === 0 ? [] : [cut(ctx, { phase: "queue", label: `${ctx.pulls.length > 1 ? `#${pull.number} ` : ""}first queue entry -> merged`, from: pull.adds[0].at, to: pull.merged?.at ?? null })]));
  if (runs.length > 0) return { runs, why: null };
  return without(ctx.pulls.some((pull) => pull.merged) ? "not reached: merged with no queue entry in the store" : "not reached: no queue entry");
}

/** `last`: the last merge of the row, which is the one that closes it */
function closeOf(ctx: Context, pull: Pull, last: boolean) {
  const merged = (pull.merged as TraceEvent);
  const rowClose = last ? ctx.rowClosed.find((event) => event.at >= merged.at) : undefined;
  return rowClose ?? (pull.closed && pull.closed.at >= merged.at ? pull.closed : undefined);
}

function mergeRuns(ctx: Context): Built {
  const merged = ctx.pulls.filter((pull) => pull.merged);
  const lastAt = Math.max(...merged.map((pull) => (pull.merged as TraceEvent).at));
  const runs = merged.map((pull) => {
    const at = (pull.merged as TraceEvent).at;
    return cut(ctx, { phase: "merge", label: `${ctx.pulls.length > 1 ? `#${pull.number} ` : ""}merged -> closed`, from: at, to: closeOf(ctx, pull, at === lastAt)?.at ?? null });
  });
  return runs.length > 0 ? { runs, why: null } : without("not reached: no pull request merged");
}

const BUILDERS: Record<string, (ctx: Context) => Built> = { spec: specRuns, claim: claimRuns, build: buildRuns, verify: verifyRuns, review: reviewRuns, CI: ciRuns, queue: queueRuns, merge: mergeRuns };

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// What a session waited on: records only, in the order they claim a moment

/** The end of a span: its own, else (still open) the close, else the reading. */
const endOf = (ctx: Context, ms: number | null | undefined) => ms ?? ctx.stop ?? ctx.now;

function deferralSources(ctx: Context): WaitSource[] {
  return ctx.events.filter((event) => event.kind === "deferral").map((event) => ({
    source: "deferral-log", inferred: false, evidence: [event.id], label: `order ${event.causeKey} deferred for busy ${event.session} (${event.how})`,
    spans: normalize([[event.startedAt ?? event.at, event.completedAt ?? event.at]]),
  }));
}

/** Each label put on and taken off: a hold or an order to a session. A label still on runs to the close or the reading. */
function holdSources(ctx: Context): WaitSource[] {
  const on: Map<string, TraceEvent> = new Map();
  const held: WaitSource[] = [];
  const close = (put: TraceEvent, to: number) => {
    const name = put.name ?? "";
    const target = name.startsWith(ANSWER_PREFIX) ? `waiting on ${name.slice(ANSWER_PREFIX.length)}` : "held";
    held.push({ source: "label", inferred: false, evidence: [put.id], label: `label ${name} (${target}; put on by ${put.actor})`, spans: normalize([[put.at, to]]) });
  };
  for (const event of ctx.events.filter((e) => e.source === "github" && (e.kind === "labeled" || e.kind === "unlabeled") && e.name)) {
    const key = `${event.row ?? ""}/${event.pr ?? ""}\t${event.name}`;
    const put = on.get(key);
    if (event.kind === "labeled" && !put) on.set(key, event);
    else if (event.kind === "unlabeled" && put) {
      close(put, event.at);
      on.delete(key);
    }
  }
  for (const put of on.values()) close(put, endOf(ctx, null));
  return held.filter((source) => source.spans.length > 0);
}

/** An order is delivered some time after `wake` typed it: that stretch is recorded (`deliveryLagMs`, delivery minus typing). One wait per addressee: a seat gets dozens, most under a second. */
function deliverySources(ctx: Context): WaitSource[] {
  const late = ctx.wakes.filter((wake) => (wake.deliveryLagMs ?? 0) > 0);
  const lag = (wake: TraceEvent) => (wake.deliveryLagMs as number);
  return [...new Set(late.map((wake) => wake.session))].map((session) => {
    const own = late.filter((wake) => wake.session === session);
    return { source: "wake-ledger", inferred: false, evidence: own.map((wake) => wake.id), spans: normalize(own.map((wake) => ([wake.at - lag(wake), wake.at] as Span))),
      label: `${own.length} order${own.length === 1 ? "" : "s"} to ${session} delivered after being typed (longest ${duration(Math.max(...own.map(lag)))})` };
  });
}

/** Each queue entry (add to its exit, or to the merge) and each stretch ejected (an unmerged exit to the next entry). */
function queueSources(ctx: Context, pull: Pull): WaitSource[] {
  const exits = [...pull.removes, ...(pull.merged ? [pull.merged] : [])].sort(byTime);
  const sources: WaitSource[] = [];
  pull.adds.forEach((add, index) => {
    const exit = exits.find((event) => event.at >= add.at);
    const to = exit?.at ?? endOf(ctx, null);
    sources.push({ source: "merge-queue", inferred: false, evidence: [add.id], label: `#${pull.number} in the merge queue (entry ${index + 1} of ${pull.adds.length})`, spans: normalize([[add.at, to]]) });
    const next = pull.adds[index + 1];
    if (exit?.kind === "removed_from_merge_queue" && exit.outcome === "unmerged" && next) {
      sources.push({ source: "merge-queue", inferred: false, evidence: [exit.id], label: `#${pull.number} ejected from the merge queue, awaiting re-entry`, spans: normalize([[exit.at, next.at]]) });
    }
  });
  return sources;
}

/** One source per head: the stretch any of its check-runs was going. */
function ciSources(ctx: Context, pull: Pull): WaitSource[] {
  return headsRun(pull).map((sha) => {
    const runs = pull.ci.filter((run) => run.headSha === sha);
    const spans = normalize(runs.map((run) => ([run.startedAt ?? run.at, endOf(ctx, run.completedAt)] as Span)));
    return { source: "CI", inferred: false, evidence: runs.map((run) => run.id), label: `CI running at head ${short(sha)} (${runs.length} check-runs)`, spans };
  });
}

/** A review round's own span is a record: it began and no review had yet been posted. */
function reviewSources(rounds: Cut[], now: number): WaitSource[] {
  return rounds.map((round) => ({ source: "review", inferred: false, evidence: [], label: `review not yet posted (${round.label.replace(/ -> review$/, "")})`, spans: normalize([[round.from, round.to ?? now]]) }));
}

/** The review's own id, which is in the event id (`gh:<repo>#<n>:reviewed:<id>:<sha>`). */
const reviewIdOf = (review: TraceEvent) => /:reviewed:(\d+):/.exec(review.id)?.[1] ?? review.id;

/**
 * INFERRED: a draft APPROVED and not yet marked ready. Nothing records who it was waiting on, so it is named from three records and marked inferred: the review event, the ledger's
 * delivery of the order about the pull request (to whoever it went to), and that session's own turns in the gap. With no order recorded it says so rather than naming nobody.
 */
function approvedDraftSource(ctx: Context, pull: Pull): WaitSource[] {
  const approval = pull.reviews.find((review) => review.state === "APPROVED");
  if (!approval || !pull.ready || approval.at >= pull.ready.at) return [];
  const gap = ([approval.at, pull.ready.at] as Span);
  const orders = ctx.wakes.filter((wake) => wake.pr === pull.number && wake.at >= gap[0] && wake.at <= gap[1]);
  const sessions = [...new Set(orders.map((wake) => wake.session))];
  const turns = ctx.turns.filter((turn) => sessions.includes(turn.session) && turn.at >= gap[0] && turn.at <= gap[1]);
  const evidence = [`review ${reviewIdOf(approval)} APPROVED by ${approval.actor} at ${stamp(approval.at)} at head ${short(approval.headSha)}`,
    ...(orders.length === 0 ? ["no order about it in the ledger within the gap"] : orders.map((wake) => `order ${wake.causeKey} delivered to ${wake.session} at ${stamp(wake.at)}`)),
    ...sessions.map((session) => `${session}: ${turns.filter((turn) => turn.session === session).length} turns in the gap`)];
  return [{ source: "approved-draft", inferred: true, evidence, spans: normalize([gap]),
    label: `approved draft #${pull.number} not yet marked ready${sessions.length > 0 ? `, waiting on ${sessions.join(", ")}` : ""}` }];
}

/**
 * A tool call running, one source per session, read from each turn's own `toolMs` (the store's measure of the stretch between the message that made the call and its result). That
 * stretch is in no turn's span: the span starts after the tool finished. It is placed ending where the turn's span begins, which is within the harness's few seconds of where it
 * ran (an attachment is stamped after the result), and a turn with no `toolMs` (an order before it, a store line from before the field) claims nothing: `null` is not 0 here either.
 */
function toolSources(ctx: Context): WaitSource[] {
  const bySession: Map<string, TraceEvent[]> = new Map();
  for (const turn of ctx.turns) {
    if (typeof turn.toolMs !== "number" || typeof turn.wallClockMs !== "number") continue;
    bySession.set(turn.session, [...(bySession.get(turn.session) ?? []), turn]);
  }
  return [...bySession].map(([session, turns]) => ({
    source: "tool", inferred: false, evidence: turns.map((turn) => turn.id), label: `tool running (${session}, ${turns.length} ${turns.length === 1 ? "call" : "calls"})`,
    spans: normalize(turns.map((turn) => {
      const spanStart = turn.at - (turn.wallClockMs as number);
      return ([spanStart - (turn.toolMs as number), spanStart] as Span);
    })),
  }));
}

/** Returns in the order they claim a moment: the recorded causes first, and a tool running last, so it names only what nothing else had */
function waitSources(ctx: Context, reviewCuts: Cut[], now: number): WaitSource[] {
  return [...deferralSources(ctx), ...holdSources(ctx), ...deliverySources(ctx), ...ctx.pulls.flatMap((pull) => queueSources(ctx, pull)),
    ...ctx.pulls.flatMap((pull) => ciSources(ctx, pull)), ...reviewSources(reviewCuts, now), ...ctx.pulls.flatMap((pull) => approvedDraftSource(ctx, pull)), ...toolSources(ctx)];
}

/** Every moment of `span` as WORKING, WAITING (by the first source that claims it) or unexplained. */
function classify(span: Span, { working, sources }: { working: Span[]; sources: WaitSource[]; }): { workingMs: number; waits: Wait[]; unexplainedMs: number; } {
  const whole = normalize([span]);
  const worked = intersect(whole, working);
  let rest = minus(whole, worked);
  const waits: Wait[] = [];
  for (const source of sources) {
    const hit = intersect(rest, source.spans);
    if (hit.length === 0) continue;
    waits.push({ source: source.source, label: source.label, inferred: source.inferred, evidence: source.evidence, ms: lengthOf(hit) });
    rest = minus(rest, hit);
  }
  return { workingMs: lengthOf(worked), waits, unexplainedMs: lengthOf(rest) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Placing a moment in one phase

/** a run with its end settled: an open one ends at the reading */
type Resolved = Cut & { end: number };

/** The run that began last of those running at `at` (`from <= at < end`, or an empty one at `at`), or `null`. */
function primaryAt(runs: Resolved[], at: number) {
  const running = runs.filter((run) => run.from <= at && (at < run.end || (run.from === run.end && at === run.end)));
  return running.sort((a, b) => b.from - a.from || PHASES.indexOf(b.phase) - PHASES.indexOf(a.phase))[0] ?? null;
}

/**
 * Cut `[start, end]` at every boundary and give each piece to the phase that began last of those running over it, or to `between`.
 * Returns the wall-clock each phase has to itself, and the stretches no phase covers
 */
function partition(runs: Resolved[], span: Span): { exclusive: Map<string, number>; holes: Span[]; } {
  const points = [...new Set([span[0], span[1], ...runs.flatMap((run) => [run.from, run.end])].filter((at) => at >= span[0] && at <= span[1]))].sort((a, b) => a - b);
  const exclusive: Map<string, number> = new Map();
  const holes: Span[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [from, to] = [points[i], points[i + 1]];
    const owner = primaryAt(runs.filter((run) => run.end > run.from), from);
    exclusive.set(owner?.phase ?? BETWEEN, (exclusive.get(owner?.phase ?? BETWEEN) ?? 0) + (to - from));
    if (!owner) holes.push([from, to]);
  }
  return { exclusive, holes: normalize(holes) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Dollars and tokens

const emptySpend = (): Spend => ({ turns: 0, priced: 0, unpriced: 0, dollars: 0, tokens: 0 });

/** The store's own `costUsd`; a turn with none is unpriced and is NOT zero dollars. */
function addTurn(spend: Spend, turn: TraceEvent) {
  spend.turns += 1;
  const tokens = turn.tokens;
  spend.tokens += tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h : 0;
  if (typeof turn.costUsd === "number") {
    spend.dollars += turn.costUsd;
    spend.priced += 1;
  } else spend.unpriced += 1;
}

function spendOf(turns: TraceEvent[]): Spend & { bySession: Record<string, Spend>; } {
  const total = { ...emptySpend(), bySession: ({} as Record<string, Spend>) };
  for (const turn of turns) {
    addTurn(total, turn);
    addTurn(total.bySession[turn.session] ??= emptySpend(), turn);
  }
  return total;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Repeats

/** `at`: the head the pull request had at a time: the latest push, review or check-run seen by then */
function headAt(pull: Pull, at: number): string | null {
  const seen = [...pull.heads.map((e) => ({ at: e.at, sha: e.headSha })), ...pull.reviews.map((e) => ({ at: e.at, sha: e.headSha })), ...pull.ci.map((e) => ({ at: e.startedAt ?? e.at, sha: e.headSha }))]
    .filter((entry) => entry.sha && entry.at <= at).sort((a, b) => a.at - b.at);
  return seen.at(-1)?.sha ?? null;
}

function secondReviews(pull: Pull): Omit<Repeat, "phase">[] {
  const at: Map<string, TraceEvent[]> = new Map();
  for (const review of pull.reviews.filter((e) => e.headSha)) at.set((review.headSha as string), [...(at.get(review.headSha as string) ?? []), review]);
  return [...at].flatMap(([sha, reviews]) => reviews.slice(1).map((again) => ({
    kind: "second review at the same head", at: again.at, summary: `#${pull.number}: review ${reviewIdOf(again)} at head ${short(sha)} after review ${reviewIdOf(reviews[0])}`,
    evidence: reviews.slice(0, reviews.indexOf(again) + 1).map((r) => `review ${reviewIdOf(r)} ${r.state} by ${r.actor} at ${stamp(r.at)}`),
  })));
}

function requeues(pull: Pull): Omit<Repeat, "phase">[] {
  return pull.adds.flatMap((add, index) => {
    const before = pull.adds.slice(0, index).find((earlier) => headAt(pull, earlier.at) === headAt(pull, add.at) && headAt(pull, add.at) !== null);
    if (!before) return [];
    return [{ kind: "re-queue at the same head", at: add.at, summary: `#${pull.number}: entered the merge queue again at head ${short((headAt(pull, add.at) as string))}`,
      evidence: [`queue entry ${before.id} at ${stamp(before.at)}`, `queue entry ${add.id} at ${stamp(add.at)}`] }];
  });
}

/** `only`: the names to list, else all */
function waveText(wave: TraceEvent[], only?: string[]) {
  const runs = wave.filter((run) => !only || only.includes(String(run.name)));
  const names = [...new Set(runs.map((run) => String(run.name)))];
  const listed = names.length <= WAVE_NAMES ? names.join(", ") : `${names.slice(0, WAVE_NAMES).join(", ")}, and ${names.length - WAVE_NAMES} more`;
  return `${runs.length} check-runs from ${stamp(Math.min(...runs.map((run) => run.startedAt ?? run.at)))} (${listed})`;
}

/**
 * Checks run again at a head they had already been run at: a check of a later WAVE whose name ran in an earlier one. A wave of checks no earlier wave ran (the ready mark and the
 * queue start their own) is not a re-run, and neither is a second trigger of the same wave.
 */
function ciReruns(pull: Pull): Omit<Repeat, "phase">[] {
  return wavesByHead(pull).flatMap(({ sha, waves }) => waves.slice(1).flatMap((wave, index) => {
    const earlier = new Set(waves.slice(0, index + 1).flat().map((run) => String(run.name)));
    const again = [...new Set(wave.map((run) => String(run.name)).filter((name) => earlier.has(name)))];
    if (again.length === 0) return [];
    const before = waves.slice(0, index + 1).findLast((one) => one.some((run) => again.includes(String(run.name)))) ?? waves[index];
    return [{ kind: "CI re-run at the same head", at: Math.min(...wave.filter((run) => again.includes(String(run.name))).map((run) => run.startedAt ?? run.at)),
      summary: `#${pull.number}: ${again.length} ${again.length === 1 ? "check" : "checks"} run again at head ${short(sha)} (wave ${index + 2}: ${again.slice(0, WAVE_NAMES).join(", ")}${again.length > WAVE_NAMES ? `, and ${again.length - WAVE_NAMES} more` : ""})`,
      evidence: [`before: ${waveText(before, again)}`, `again: ${waveText(wave, again)}`] }];
  }));
}

/** A wake whose session and ledger key (without `@deferred`) were delivered before. */
function rewakes(ctx: Context): Omit<Repeat, "phase">[] {
  const last: Map<string, TraceEvent> = new Map();
  const repeats: Omit<Repeat, "phase">[] = [];
  for (const wake of ctx.wakes.filter((e) => e.causeKey)) {
    const key = `${wake.session}\t${String(wake.causeKey).split(DEFERRED_MARK)[0]}`;
    const before = last.get(key);
    if (before) repeats.push({ kind: "re-wake with the same cause key", at: wake.at, summary: `${wake.session}: ${wake.causeKey}`,
      evidence: [`delivered ${stamp(before.at)} (${before.id})`, `delivered again ${stamp(wake.at)} (${wake.id}), ${duration(wake.at - before.at)} later`] });
    last.set(key, wake);
  }
  return repeats;
}

function compactions(ctx: Context): Omit<Repeat, "phase">[] {
  return ctx.events.filter((event) => event.kind === "compaction").map((event) => ({ kind: "compaction", at: event.at, summary: `${event.session} compacted its window`, evidence: [event.id] }));
}

/** The phase each kind of repeat belongs to by its nature; one that happens whenever (a wake, a compaction) is in whichever phase was running. */
const OWN_PHASE = { "second review at the same head": "review", "re-queue at the same head": "queue", "CI re-run at the same head": "CI" };

function repeatsOf(ctx: Context, runs: Resolved[]): Repeat[] {
  const found = [...ctx.pulls.flatMap((pull) => [...secondReviews(pull), ...requeues(pull), ...ciReruns(pull)]), ...rewakes(ctx), ...compactions(ctx)];
  return found.sort((a, b) => a.at - b.at).map((repeat) => ({ ...repeat, phase: (OWN_PHASE as Record<string, string>)[repeat.kind] ?? primaryAt(runs, repeat.at)?.phase ?? BETWEEN }));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The waterfall

type Run = { phase: string; label: string; from: number; to: number | null; end: number; state: "ended" | "open" | "cut"; note?: string; wallClockMs: number;
  workingMs: number; waits: Wait[]; unexplainedMs: number };
export type Phase = { phase: string; state: "ended" | "open" | "cut" | "not reached" | "not held"; why: string | null; runs: Run[]; wallClockMs: number; exclusiveMs: number; workingMs: number;
  waits: Wait[]; unexplainedMs: number; spend: ReturnType<typeof spendOf>; repeats: Repeat[] };

/** Returns the same wait of several runs, once */
function mergeWaits(runs: Run[]): Wait[] {
  const merged: Map<string, Wait> = new Map();
  for (const wait of runs.flatMap((run) => run.waits)) {
    const key = `${wait.source}\t${wait.label}`;
    const known = merged.get(key);
    if (known) known.ms += wait.ms;
    else merged.set(key, { ...wait });
  }
  return [...merged.values()].sort((a, b) => b.ms - a.ms);
}

const resolve = (cutRun: Cut, now: number): Resolved => ({ ...cutRun, end: cutRun.to ?? now });

function runOf(run: Resolved, held: { working: Span[]; sources: WaitSource[]; }): Run {
  return { ...run, ...classify([run.from, run.end], held), wallClockMs: run.end - run.from };
}

function betweenRuns(runs: Resolved[], holes: Span[], held: { working: Span[]; sources: WaitSource[]; }): Run[] {
  return holes.map(([from, to]) => {
    const before = runs.filter((run) => run.end <= from).sort((a, b) => b.end - a.end)[0];
    const after = runs.filter((run) => run.from >= to).sort((a, b) => a.from - b.from)[0];
    return runOf({ phase: BETWEEN, label: `after ${before?.phase ?? "the start"}, before ${after?.phase ?? "the end"}`, from, to, end: to, state: "ended" }, held);
  });
}

function phaseOf(phase: string, built: Built, { runs, exclusive, turns, repeats }: { runs: Run[]; exclusive: number; turns: TraceEvent[]; repeats: Repeat[]; }): Phase {
  const states = new Set(runs.map((run) => run.state));
  const state = runs.length === 0 ? (built.why?.startsWith("not held") ? "not held" : "not reached" as "not reached" | "not held")
    : states.has("open") ? "open" : states.has("cut") ? "cut" : "ended";
  return {
    phase, state, why: runs.length === 0 ? built.why : null, runs, wallClockMs: runs.reduce((sum, run) => sum + run.wallClockMs, 0), exclusiveMs: exclusive,
    workingMs: runs.reduce((sum, run) => sum + run.workingMs, 0), waits: mergeWaits(runs), unexplainedMs: runs.reduce((sum, run) => sum + run.unexplainedMs, 0),
    spend: spendOf(turns), repeats: repeats.filter((repeat) => repeat.phase === phase),
  };
}

/**
 * The waterfall of one row's events, read at `now`.
 * `input`: `events` as `eventsForRow` returns them (`gh_call`s are ignored)
 */
export function waterfall({ events, now }: { events: TraceEvent[]; now: number; }): {
    start: number | null; end: number | null; open: boolean; whole: { wallClockMs: number; workingMs: number; waits: Wait[]; unexplainedMs: number; };
    phases: Phase[]; between: Phase; spend: ReturnType<typeof spendOf>; repeats: Repeat[]; rows: number[];
} {
  const ctx = contextOf(events, now);
  const built = PHASES.map((phase) => ({ phase, ...BUILDERS[phase](ctx) }));
  const cuts = built.flatMap((one) => one.runs);
  const runs = cuts.map((run) => resolve(run, now));
  const start = runs.length === 0 ? null : Math.min(...runs.map((run) => run.from));
  const end = runs.length === 0 ? null : Math.max(...runs.map((run) => run.end));
  const held = { working: normalize(ctx.turns.map(turnSpan)), sources: waitSources(ctx, cuts.filter((run) => run.phase === "review"), now) };
  const { exclusive, holes } = start === null || end === null ? { exclusive: new Map(), holes: [] } : partition(runs, [start, end]);
  const turnPhase = new Map(ctx.turns.map((turn) => [turn, primaryAt(runs, turn.at)?.phase ?? BETWEEN]));
  const turnsIn = (phase: string) => ctx.turns.filter((turn) => turnPhase.get(turn) === phase);
  const repeats = repeatsOf(ctx, runs);
  const phases = built.map((one) => phaseOf(one.phase, one, { runs: runs.filter((run) => run.phase === one.phase).map((run) => runOf(run, held)), exclusive: exclusive.get(one.phase) ?? 0, turns: turnsIn(one.phase), repeats }));
  const between = phaseOf(BETWEEN, without(""), { runs: betweenRuns(runs, holes, held), exclusive: exclusive.get(BETWEEN) ?? 0, turns: turnsIn(BETWEEN), repeats });
  const whole = start === null || end === null ? { wallClockMs: 0, workingMs: 0, waits: [], unexplainedMs: 0 } : { wallClockMs: end - start, ...classify([start, end], held) };
  const rows = [...new Set(ctx.events.flatMap((event) => (typeof event.row === "number" ? [event.row] : [])))];
  return { start, end, open: runs.some((run) => run.state === "open"), whole, phases, between, spend: spendOf(ctx.turns), repeats, rows };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Printing

function spendText(spend: Spend) {
  const dollars = spend.priced === 0 ? (spend.turns === 0 ? "no turns" : "$? (no priced turn)") : `${spend.unpriced > 0 ? ">= " : ""}$${spend.dollars.toFixed(COST_DECIMALS)}`;
  return `${dollars} over ${spend.priced} priced turns${spend.unpriced > 0 ? `, ${spend.unpriced} UNPRICED (not counted as 0)` : ""}, ${spend.tokens.toLocaleString("en-US")} tokens`;
}

const waitLine = (wait: Wait) => `        WAITING ${duration(wait.ms).padStart(9)}  ${wait.label}${wait.inferred ? `  [INFERRED from: ${wait.evidence.join("; ")}]` : ""}`;

/** `alone`: the phase's only run, whose totals its header line already carries */
function runLines(run: Run, alone: boolean) {
  const where = run.state === "open" ? `${stamp(run.from)} -> OPEN (still running at the reading)` : `${stamp(run.from)} -> ${stamp(run.end)}${run.state === "cut" ? " (CUT at the close: no ending record)" : ""}`;
  const totals = `        wall-clock ${duration(run.wallClockMs)} = WORKING ${duration(run.workingMs)} + WAITING ${duration(run.wallClockMs - run.workingMs - run.unexplainedMs)} + unexplained ${duration(run.unexplainedMs)}`;
  return [`      ${run.label}: ${where}`, ...(alone ? [] : [totals]), ...run.waits.map(waitLine), ...(run.note ? [`        note: ${run.note}`] : [])];
}

function phaseLines(phase: Phase) {
  const head = `  ${phase.phase.padEnd(7)} ${phase.state.toUpperCase()}`;
  if (phase.runs.length === 0) return [`${head}  ${phase.why ?? ""}`];
  const waiting = phase.wallClockMs - phase.workingMs - phase.unexplainedMs;
  const lines = [`${head}  wall-clock ${duration(phase.wallClockMs)} (exclusive ${duration(phase.exclusiveMs)}) = WORKING ${duration(phase.workingMs)} + WAITING ${duration(waiting)} + unexplained ${duration(phase.unexplainedMs)}`,
    `      spend by the turns that ended in it: ${spendText(phase.spend)}`];
  const sessions = Object.entries(phase.spend.bySession);
  if (sessions.length > 1) lines.push(...sessions.map(([session, spend]) => `        ${session.padEnd(20)} ${spendText(spend)}`));
  for (const run of phase.runs) lines.push(...runLines(run, phase.runs.length === 1));
  for (const repeat of phase.repeats) lines.push(`      REPEAT ${repeat.kind}: ${repeat.summary}`, ...repeat.evidence.map((line) => `        evidence: ${line}`));
  return lines;
}

/** The waterfall as text. */
export function renderWaterfall(wf: ReturnType<typeof waterfall>, { title, now }: { title: string; now: number; }): string[] {
  const lines = [`WATERFALL ${title}  (read ${stamp(now)}Z)`];
  if (wf.start === null) return [...lines, "  no phase has a record in the store: nothing to draw (is the row's GitHub history ingested? widen --since)"];
  const waiting = wf.whole.wallClockMs - wf.whole.workingMs - wf.whole.unexplainedMs;
  lines.push(`  whole row ${stamp(wf.start)} -> ${wf.open ? "OPEN" : stamp(wf.end as number)}: wall-clock ${duration(wf.whole.wallClockMs)} = WORKING ${duration(wf.whole.workingMs)} + WAITING ${duration(waiting)} + unexplained ${duration(wf.whole.unexplainedMs)}`,
    `  spend: ${spendText(wf.spend)}`, ...Object.entries(wf.spend.bySession).map(([session, spend]) => `    ${session.padEnd(22)} ${spendText(spend)}`));
  for (const phase of wf.phases) lines.push(...phaseLines(phase));
  if (wf.between.runs.length > 0 || wf.between.spend.turns > 0) lines.push(...phaseLines(wf.between));
  lines.push("  phases overlap, so their wall-clocks add to more than the row's; EXCLUSIVE counts each moment once and adds up to it");
  return lines;
}
