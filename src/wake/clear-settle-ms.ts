import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { blastTail, readBlockingRecord } from "../blast-tail.ts";
import { haikuBriefTail } from "../haiku-brief.ts";
import type { BlockingRecord } from "../blocking-impact.ts";
import { escalationNote } from "../engineer-escalation.ts";
import { armOf, ARM, CALM_FINISH_PARAGRAPH, tripsArmOf, TRIPS_ARM, ROUND_TRIPS_PARAGRAPH } from "../worker-profile.ts";
import { ANSWER_PREFIX } from "../waiting-condition.ts";
import { LAUNCH_PLACEHOLDER } from "../work-gate/vocabulary.ts";
import type { ReviewTrust } from "../review-trust.ts";
import { HOME_CHECKOUT, homeProjectDeclaration } from "../project-config.ts";
import { stateEntryPath } from "../host-config.ts";
import type { ServedRecord } from "../serve-by-run.ts";
import type { AccountLimit } from "../account-limit.ts";
import { engineerBriefSentence, briefRoleSentence } from "../spawn-role-brief.ts";
import type { OrchestratorOneShot } from "../orchestrator-one-shot.ts";
import type { CeoOneShot } from "../ceo-one-shot.ts";
import { SPARE_FAMILIES, familyMember } from "../arm-pr.ts";
import { firstLine, herdrReason, closedNote } from "../herdr-agents.ts";
import { isAbsentReviewerSeat } from "../seat-retire-reset.ts";
import { FYI_STALE_MS, HANDOFF_STALE_MS, SESSIONS_FILE, declaresDecision, dropHandoffs, isLeadSeat, staleHandoffs, undelivered } from "./reset.ts";
import { CLEAR_TIMEOUT_MS, CONTEXT_ACTION, CONTINUATION_ESCALATE_TO, MAX_DELIVERIES, NO_CLOCK, continuationOf, endedSeatLine, engineerStarts, escalatedContinuation, holdsAsFyi, isPerRowInstance, keepsContext, overThreshold, postOutsideVerdictsOf, recentOrderAction, recordCapped, registerSpawn, sleepSync, targetFor, type ClaimOrders, type HostLoad, type LaunchFacts, type OrderClock, whyUnavailable } from "./holds-as-fyi.ts";
import { ENGINEER_BRIEF_ABSOLUTE, engineerRoles, spawnEnvironment, startBudgetOf, type ClaimRefused, type ClaimedRow, type SpawnClaimer, type ToolchainGate } from "./is-pull-request-spawn-order.ts";
import { isReviewerOrder, registerReviewer, type ReviewerDeps } from "./ensure-reviewer-token.ts";
import { defaultRun, rowMention } from "./exit.ts";

/**
 * SPLIT THE QUEUE INTO WHAT THIS TICK MAY DELIVER, WHAT STAYS HELD, AND WHAT HAS EXPIRED (#3562).
 *
 * A REAL ORDER IS THE SEAT'S WAKE-UP AND AN FYI IS LUGGAGE ON IT. `deliver` is the unit of a wake and clears a seat's window first, so an FYI that
 * delivered itself paid a whole starting-context write to say nothing was asked. Here the seats that have a real handoff this tick take their
 * FYIs in the same batch; the gate's own orders carry theirs through {@link ridingGateOrders}; every other FYI is `held`, and one past
 * {@link FYI_STALE_MS} is `expired` -- dropped by the caller with a line, never delivered late.
 */
export function foldFyis<T extends {id: string, session: string, queuedAt?: number, decision?: boolean, fyi?: boolean, resume?: boolean}>(handoffs: readonly T[], { now = Date.now(), isLead = isLeadSeat }: { now?: number; isLead?: (label: string) => boolean; } = {}): { deliver: T[]; held: T[]; expired: T[]; } {
  const fyis = handoffs.filter((h) => holdsAsFyi(h, isLead));
  const real = handoffs.filter((h) => !fyis.includes(h));
  const expired = fyis.filter((h) => now - Number(h.queuedAt ?? 0) >= FYI_STALE_MS);
  const live = fyis.filter((h) => !expired.includes(h));
  const waking = new Set(real.map((h) => h.session));
  return { deliver: [...real, ...live.filter((h) => waking.has(h.session))], held: live.filter((h) => !waking.has(h.session)), expired };
}

/**
 * The line a tick prints for an FYI it dropped unread: which seat, how old, and the opening of what it said, so the author can put it on a row.
 */
export function expiredFyiLine(fyi: { id: string; session: string; prompt: string; queuedAt?: number; }, now: number = Date.now()) {
  const first = fyi.prompt.replace(/\s+/g, " ").slice(0, 100);
  return `DROPPED FYI ${fyi.id} to ${fyi.session}: queued ${waitedFor(now - Number(fyi.queuedAt ?? now))} ago and no real order reached the seat inside `
    + `${Math.round(FYI_STALE_MS / 3_600_000)}h, so it asked nothing and is now stale. It began: "${first}"\n`;
}

/**
 * DROP THE EXPIRED FYIs, SAYING SO. `dropHandoffs` appends a retirement and the text stays in the log, so a drop loses nothing a person cannot read back.
 */
export function dropExpiredFyis(expired: readonly { id: string; session: string; prompt: string; queuedAt?: number; }[], queuePath: string, { drop = dropHandoffs, say = (line) => { process.stderr.write(line); }, now = Date.now() }: { drop?: typeof dropHandoffs; say?: (line: string) => void; now?: number; } = {}) {
  if (expired.length === 0) return;
  drop(queuePath, expired.map((f) => f.id));
  for (const fyi of expired) say(expiredFyiLine(fyi, now));
}

/**
 * RETIRE THE FYIs A GATE ORDER CARRIED, once `deliver` has recorded that order as sent. A recipient that is not the addressed seat (`record`'s second
 * argument, #3568's re-route) did not receive what was written to the addressed one, so those FYIs stay held.
 */
export function retireRiddenFyis(ids: readonly string[] | undefined, recipient: string | undefined, queuePath: string, drop: typeof dropHandoffs = dropHandoffs) {
  if (ids === undefined || recipient !== undefined) return;
  drop(queuePath, [...ids]);
}

/** How many bytes of held FYIs ride one gate order: well inside {@link HANDOFF_BATCH_BYTES}, which the order's own text also spends from. */
const FYI_RIDE_BYTES = 16 * 1024;

/**
 * THE HELD FYIs, AS A SECTION OF THE ORDER THEY RIDE IN. It says they ask nothing and are readings at the moment they were sent, because that is
 * what separates luggage from the order the seat was woken for.
 */
function fyiSection(fyis: readonly { prompt: string; queuedAt?: number; }[], now: number) {
  const items = fyis.map((f, i) => `FYI ${i + 1} (queued ${waitedFor(now - Number(f.queuedAt ?? now))} ago):\n${f.prompt}`);
  return `WAITING FOR YOUR NEXT ORDER, THIS ONE: ${fyis.length} FYI${fyis.length === 1 ? "" : "s"} that asked nothing of you and so did not wake you. `
    + `Each is a reading at the moment it was sent -- re-read anything it names.\n\n${items.join("\n\n")}`;
}

/**
 * LET THE HELD FYIs RIDE THE GATE'S OWN ORDERS (#3562): each order addressed to a seat that has some takes them, up to {@link FYI_RIDE_BYTES}, and the
 * ids come back keyed by the order's causeKey so the caller retires them only when `deliver` records that order as sent. An order that is refused,
 * deferred or re-routed to a different seat carries nothing away: its FYIs stay held for the next tick.
 */
export function ridingGateOrders<O extends {session: string, causeKey: string, prompt: string}, F extends {id: string, session: string, prompt: string, queuedAt?: number}>(orders: readonly O[], held: readonly F[], now: number = Date.now()): { orders: O[]; rides: Map<string, string[]>; } {
  const rides: Map<string, string[]> = new Map();
  const taken = new Set();
  const carrying = orders.map((order) => {
    const mine = held.filter((f) => f.session === order.session && !taken.has(f.session));
    if (mine.length === 0) return order;
    taken.add(order.session);
    const { take } = fitBatch(mine, FYI_RIDE_BYTES, now);
    rides.set(order.causeKey, take.map((f) => f.id));
    return { ...order, prompt: `${order.prompt}\n\n${fyiSection(take, now)}` };
  });
  return { orders: carrying, rides };
}

/**
 * The stale-order lines a tick prints -- OVER WHAT IS STILL WAITING, not over what it read.
 *
 * `retired` is what this tick's deliveries carried, and subtracting it is the whole function. `main` used
 * to build these lines from the PRE-delivery list, so an order handed over seconds earlier was announced
 * as *"still not delivered"* -- and with a batch retiring dozens of ids at once that is dozens of false
 * statements per tick, in the one output an operator is meant to trust. Extracted so the subtraction is
 * pinned rather than living in a `main` no test can call.
 */
export function staleReport(handoffs: readonly { id: string; session: string; queuedAt?: number; }[], retired: readonly string[], now: number = Date.now()): string[] {
  const gone = new Set(retired);
  return staleHandoffs(handoffs.filter((h) => !gone.has(h.id)), now)
    .map((h) => `STALE QUEUED ORDER ${h.id} -- written for "${h.session}" over `
      + `${Math.round(HANDOFF_STALE_MS / 3_600_000)}h ago and still not delivered. Nothing drops it; `
      + "check that session exists and is reachable.\n");
}

/**
 * HOW LONG SOMETHING HAS WAITED, in one dialect, because two would be read side by side.
 *
 * Minutes under the hour and hours with one decimal above it -- and the minutes branch is the wording
 * {@link handoffOrder} has always used, kept to the letter so the two are the same sentence rather than
 * two sentences that happen to agree. A queue measured in minutes was the case #1966 designed for; one
 * measured in hours is the case this row was filed on, and "587 minute(s)" is a number a reader has to
 * do arithmetic on before it means anything.
 */
export function waitedFor(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60 * 60_000) return `${Math.round(safe / 60_000)} minute(s)`;
  return `${(safe / 3_600_000).toFixed(1)}h`;
}

/**
 * WHAT IS ALREADY WAITING, PER TARGET -- the reading this row was filed for.
 *
 * `staleHandoffs` above names individual orders once they pass two hours, and that is the wrong shape for
 * the failure that actually happened: 57 orders for ONE session print 57 lines that say nothing about the
 * one fact worth knowing, which is that a single inbox has stalled and how long ago it stalled. An
 * aggregate per target is a sentence a reader can act on; a list of ids is a list of ids.
 *
 * WORST FIRST, then by name. A tick's output is read by whoever is passing, and the session whose oldest
 * order has waited longest is the one to look at; ordering by name would bury a 10-hour backlog under a
 * two-minute one. The name tie-break is there so the same queue prints the same way twice -- a report
 * that reorders itself between ticks cannot be diffed, and `route`'s own comment makes the same argument
 * about picks that cannot be reproduced.
 *
 * `decisions` IS HOW MANY OF THEM DECLARE THEY ASK FOR AN ANSWER (#2222) -- the queue read for what is
 * OWED rather than only how deep it is. It counts DECLARATIONS and nothing else: an undeclared order is
 * FYI ({@link declaresDecision}), so this is a floor on what is owed, never a count of it.
 */
export function handoffBacklog(handoffs: readonly { session: string; queuedAt?: number; decision?: boolean; }[], now: number = Date.now()): { session: string; waiting: number; oldestMs: number; stale: number; decisions: number; }[] {
  const bySession: Map<string, {
      session: string; waiting: number; oldestMs: number; stale: number;
      decisions: number;
  }> = new Map();
  for (const h of handoffs) {
    const waited = Math.max(0, now - Number(h.queuedAt ?? now));
    const row = bySession.get(h.session)
      ?? { session: h.session, waiting: 0, oldestMs: 0, stale: 0, decisions: 0 };
    row.waiting += 1;
    if (declaresDecision(h)) row.decisions += 1;
    row.oldestMs = Math.max(row.oldestMs, waited);
    if (waited >= HANDOFF_STALE_MS) row.stale += 1;
    bySession.set(h.session, row);
  }
  return [...bySession.values()]
    .sort((a, b) => b.oldestMs - a.oldestMs || a.session.localeCompare(b.session));
}

/**
 * The backlog as the tick says it. EMPTY FOR AN EMPTY QUEUE, which is half of what this is for.
 *
 * A REPORTER THAT ALWAYS PRINTS IS A REPORTER NOBODY READS, and it is also unfalsifiable: the row's own
 * Acceptance asks for the count and the oldest age AND for the control that a quiet queue says nothing,
 * because an emptiness assertion on its own passes against a function that never reports at all (this
 * repo's Assertions rule -- the positive control is `handoffBacklog`'s own non-empty case, pinned beside
 * it).
 *
 * A TARGET THAT DOES NOT EXIST IS NOT A TARGET THAT IS NEVER IDLE (#2459). Given the live `agents`, a row whose
 * session has no workspace says so, and the stalled-inbox warning -- true only of a session that EXISTS -- is
 * replaced by what is true of one that does not. Without `agents` (herdr did not answer) nothing is known
 * about any target, and the report reads as it always did.
 */
export function backlogReport(backlog: readonly {
        session: string; waiting: number; oldestMs: number; stale: number;
        decisions?: number;
    }[], agents: readonly { label: string; }[] | null = null): string[] {
  if (backlog.length === 0) return [];
  const lines = backlog.map((b) => `QUEUE BACKLOG ${b.session}: ${b.waiting} authored order(s) waiting, `
    + `oldest ${waitedFor(b.oldestMs)}`
    + (b.stale > 0 ? `, ${b.stale} over ${Math.round(HANDOFF_STALE_MS / 3_600_000)}h` : "")
    + (b.decisions ? `, ${b.decisions} declared as asking for a decision` : "")
    + (agents !== null && isAbsent(b.session, agents) ? `, NO workspace is labelled "${b.session}"` : "")
    + "\n");
  const worst = backlog[0];
  if (worst.stale === 0) return lines;
  lines.push(agents !== null && isAbsent(worst.session, agents) ? absentAdvice(worst) : stalledInboxAdvice(worst));
  return lines;
}

/**
 * THE ONE THING A COUNT DOES NOT SAY. Delivery is gated on the TARGET being between tasks, so a target
 * that is never between tasks holds its inbox for ever and no amount of ticking changes that. Nothing
 * here is dropped and nothing here is forced -- #1966's measurement is that forcing a delivery into a
 * working session wipes what it was doing -- so the only thing that clears a stalled inbox is that
 * session finishing a turn, or somebody noticing it never does.
 */
function stalledInboxAdvice(worst: { session: string; oldestMs: number; }): string {
  return `QUEUE BACKLOG: "${worst.session}" has held an order for ${waitedFor(worst.oldestMs)}. `
    + "An authored order is delivered only when the gate judges its target BETWEEN TASKS, so a session "
    + "that is never idle never receives one, and nothing here overrides that -- forcing a delivery into "
    + "a working session wipes what it was mid-way through (#1966). If this repeats, that session's "
    + "inbox is not being read: route around it, or stop sending it reports it does not need.\n";
}

/**
 * WHAT IS TRUE OF A SESSION THAT IS NOT THERE: it has no inbox, so nobody is failing to read one. And the order is
 * KEPT, because absent is not ended -- see {@link targetState}.
 */
function absentAdvice(worst: { session: string; oldestMs: number; }): string {
  return `QUEUE BACKLOG: no session is labelled "${worst.session}", so its order (waiting ${waitedFor(worst.oldestMs)}) `
    + "has no addressee -- this is NOT a busy session's unread inbox. It is KEPT rather than dropped, because "
    + "the tick has no record that this session ended: it may be an instance the gate has not started yet "
    + "(a reviewer is started AFTER an order for it can already be queued), or one that was closed without "
    + "a teardown. If it is neither, re-send the order to whoever holds the row it names.\n";
}

// --- #2459: AN ORDER TO A SESSION THAT HAS ENDED HAS NO ADDRESSEE, AND THE QUEUE USED TO KEEP IT FOR EVER ---
//
// Measured 2026-09-25 (#2459): an order for `worker-12` sat 7.1h and the tick said, every time, that a busy
// session's inbox was not being read. `worker-12` had been TORN DOWN -- engineer instances are one per row
// (#2323) -- so there was no inbox, and `route` refused it with `no workspace labelled` on every tick. Keeping
// an order for a session that is busy is right (#1966: forcing a delivery wipes the work it interrupts); a
// session that does not exist has nothing to wipe, and the same rule had been applied to it anyway.
//
// THREE TARGETS, THREE OUTCOMES ({@link targetState}): a session that exists is delivered to when it is between
// tasks, as before; one that ENDED is re-addressed or dropped, with a record, on the first tick that sees it gone;
// and one that is merely ABSENT stays queued, because absent is not ended.

/**
 * The session that wrote an order, from the line `prompt-session` puts in front of every prompt
 * ({@link attributed} in that file), or `null` when the order names nobody.
 */
export function authorOf(prompt: string): string | null {
  const found = /^Sent to you by `([^`]+)`/.exec(prompt);
  return found === null ? null : found[1];
}

/**
 * The reviewer instances' endings, from `reviewer-endings`: one JSON line per instance {@link endFinishedReviewers}
 * closed. A missing file is no endings. A LINE THAT CANNOT BE PARSED IS SKIPPED, the opposite of the spare ledger's
 * rule and for the opposite reason: that file counts failures, so an unreadable line must count against it; this
 * one is EVIDENCE OF AN ENDING, and an unreadable line cannot establish one -- an order is only ever dropped on
 * evidence that was read.
 */
export function readReviewerEndings(path: string, read: typeof readFileSync = readFileSync): { session: string; at: string; }[] {
  let text;
  try {
    text = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function isAbsent(session: string, agents: readonly { label: string; }[]): boolean {
  return session !== "engineers" && !agents.some((a) => a.label === session);
}

/**
 * WHAT RIDES ON TOP OF THE ORDERS, reserved before the first one is charged: `batchedOrder`'s header
 * plus `addressed`'s prefix and autonomy footer.
 *
 * MEASURED 2026-09-23 on a rendered batch: 647 bytes of header and 1,429 of wrapper, 2,076 together.
 * The reserve is roughly double that because both are prose somebody will edit, and prose that grows
 * past its reserve must fail a test rather than an `execFileSync`. `a batch reserves more than the
 * wrapper it actually renders` is that test; this comment is not the guarantee, it is.
 */
export const BATCH_WRAPPER_BYTES = 4 * 1024;

const oldestFirst = (a: { queuedAt?: number; }, b: { queuedAt?: number; }) => Number(a.queuedAt ?? 0) - Number(b.queuedAt ?? 0);

/**
 * ONE ORDER'S HEADING INSIDE A BATCH -- written by {@link batchedOrder} AND CHARGED BY {@link fitBatch},
 * from this one function so that the two can never disagree about what an order costs.
 *
 * THE DEFECT THIS CLOSES (review of #2125, reproduced before fixing): the budget counted only the
 * AUTHORED prompt, and the heading, the batch header and `addressed`'s wrapper all rode on top of it
 * uncharged. 3,000 valid one-byte orders therefore "fitted" in 64 KiB of authored text and rendered a
 * 165,408-byte argv -- `E2BIG` from the kernel, a herdr refusal, and `deliverHandoffs` retaining every
 * one of them. That is this row's own stall reached from the other side: a queue that cannot drain.
 * The authored text is not what `execFileSync` is handed; the rendered argv is, so the rendered argv is
 * what a budget has to be about.
 *
 * A DECLARED DECISION IS TAGGED HERE AS WELL AS LISTED IN THE HEADER (#2222), so a reader who reaches the
 * order without having read the list still sees what it is. The tag is part of this string, so
 * {@link chargeFor} charges it by construction.
 */
export function orderHeading(h: { prompt: string; queuedAt?: number; decision?: boolean; }, index: number, total: number, now: number) {
  const tag = declaresDecision(h) ? " (DECISION)" : "";
  return `--- ORDER ${index + 1} of ${total}${tag}, queued `
    + `${waitedFor(now - Number(h.queuedAt ?? now))} ago ---\n`;
}

/** The blank line `batchedOrder` joins consecutive orders with -- charged like everything else. */
const ORDER_SEPARATOR_BYTES = 2;

/**
 * THE PLACEHOLDER `addressed` EXPANDS, and the reason the authored text is still not the rendered argv.
 *
 * THE DEFECT THIS CLOSES (second review of #2125, reproduced before fixing). `orderHeading` above had
 * already moved the budget off the authored prompt and onto the heading and the wrapper -- but
 * {@link addressed} does one more thing to the body on its way to `execFileSync`: it substitutes the
 * target's name for every `<you>`, and `work-gate.ts` writes that placeholder into the row orders it
 * queues. `<you>` is five bytes and `worker-capture` is fourteen, so an order that mentions the
 * placeholder a hundred times is charged 900 bytes less than it renders. Reproduced: 3,000 queued
 * `engineers` orders each repeating `<you>` 100 times were charged as fitting and rendered 163,952
 * bytes -- past the 65,536-byte budget AND past the kernel's 131,072-byte ceiling, which is `E2BIG`
 * again from the one direction the first fix did not close.
 */
const YOU_PLACEHOLDER = "<you>";
export const YOU_PLACEHOLDER_BYTES = Buffer.byteLength(YOU_PLACEHOLDER, "utf8");

/**
 * What this order GAINS when `addressed` substitutes a name of `labelBytes` for each `<you>`.
 *
 * ZERO WHEN THE NAME IS NO WIDER THAN THE PLACEHOLDER, never negative: a shorter name renders a shorter
 * argv than the charge, and under-spending a budget is safe in the direction that matters. Only growth
 * can reach the kernel.
 */
function expansionBytes(prompt: string, labelBytes: number): number {
  const grown = labelBytes - YOU_PLACEHOLDER_BYTES;
  if (grown <= 0) return 0;
  return (prompt.split(YOU_PLACEHOLDER).length - 1) * grown;
}

/**
 * What one order adds to the rendered delivery: its own bytes AS RENDERED, its heading and its separator.
 *
 * THE HEADING IS CHARGED AT ITS WORST CASE, which is the last position in the longest batch this queue
 * could produce -- `ORDER 1000 of 1000` is four bytes wider than `ORDER 1 of 9`, and the batch's own
 * size is what decides which is written. Over-charging by a few bytes an order costs a long batch its
 * last entry at worst; under-charging costs the delivery, which is the failure above.
 *
 * `labelBytes` IS REQUIRED HERE AND HAS A DEFAULT ON {@link fitBatch}, and the asymmetry is deliberate:
 * a default that charges no expansion is the defect {@link YOU_PLACEHOLDER} records, so the function
 * doing the arithmetic may not have one. `fitBatch`'s default serves a caller with no target to name,
 * and it is safe only because the path that reaches `execFileSync` -- `deliverHandoffs` ->
 * `handoffBatches` -> `fitBatch` -- always supplies the real width, which is itself pinned by a test
 * against the delivered argv rather than by this sentence.
 */
function chargeFor(h: { prompt: string; queuedAt?: number; decision?: boolean; }, queued: number, now: number, labelBytes: number) {
  return Buffer.byteLength(h.prompt, "utf8")
    + expansionBytes(h.prompt, labelBytes)
    + Buffer.byteLength(orderHeading(h, queued - 1, queued, now), "utf8")
    + ORDER_SEPARATOR_BYTES;
}

/**
 * The orders for one target that fit in one delivery, OLDEST FIRST.
 *
 * FIFO IS THE WHOLE POINT. The failure being fixed is an order that waited ten hours; filling a batch
 * with whatever is newest would starve exactly that order for ever while the queue looked like it was
 * draining. The first order is taken WHATEVER ITS SIZE -- a single order bigger than the budget must
 * still be attempted, because skipping it is the starvation this row is about, and if it is bigger than
 * the kernel's ceiling too then herdr refuses it and the refusal is printed, which is a loud failure
 * rather than a silent one.
 *
 * THE BUDGET IS SPENT BEFORE THE LOOP STARTS, by {@link BATCH_WRAPPER_BYTES}, and each order is charged
 * by {@link chargeFor} rather than by its own length. Both exist because budgeting the authored text
 * alone let many small orders render an argv the kernel refuses; see {@link orderHeading}.
 *
 *
 *
 * @param [labelBytes] the width of the name `addressed` will put in this batch's `<you>`;
 *   the default charges no expansion and is for a caller with no target -- see {@link chargeFor}
 */
export function fitBatch<T extends {prompt: string, queuedAt?: number}>(handoffs: readonly T[], budget: number, now: number = Date.now(), labelBytes: number = YOU_PLACEHOLDER_BYTES): { take: T[]; held: T[]; } {
  const queue = [...handoffs].sort(oldestFirst);
  const take: T[] = [];
  let used = BATCH_WRAPPER_BYTES;
  for (const h of queue) {
    const size = chargeFor(h, queue.length, now, labelBytes);
    if (take.length > 0 && used + size > budget) break;
    take.push(h);
    used += size;
  }
  return { take, held: queue.slice(take.length) };
}

/** What an instance's delivery line and ledger line say in place of a clear (#2483). */
export const NO_CLEAR_NOTE = " (no clear)";

/**
 * Who a session escalates to when it is genuinely blocked.
 *
 * `product-manager` IS THE FIRST READER FOR ROWS, per the routing rule -- but this line was appended to
 * every order regardless of who received it, so the order that woke `product-manager` told it to message
 * ITSELF, and the chairman read that as the order having fired twice. `ceo` is `product-manager`'s own
 * onward route in that same rule ("three things come up from product-manager to ceo"), and `ceo`'s is the
 * chairman -- which no session can message, so it says so rather than naming a dead end.
 */
function escalationFor(label: string) {
  if (label === "product-manager") return "ceo";
  if (label === "ceo") return "the chairman on the row itself -- no session can message them";
  return "product-manager";
}

/**
 * The paragraph that tells an ENGINEER to read {@link ENGINEER_BRIEF}, or nothing for any other label.
 *
 * MEMBERSHIP IN THE ROSTER, NOT A NAME TEST: the roster is `sessions.json`'s engineer roles, so a role added
 * there is briefed with no edit here, and `ceo`, `product-manager`, `orchestrator` and a reviewer -- none of
 * which is an engineer role -- are not told to read a brief written for someone else.
 *
 * A SPARE-FAMILY MEMBER IS A MEMBER (#2403): `engineerRoles` lists ADDRESSES, and `worker-9` is listed nowhere, so
 * an address-only test would leave the instance the pilot spawns -- the one that starts knowing nothing -- the one
 * engineer never told to read the brief. The family is read from the same file, so it is a rule and not a name test.
 */
function engineerBriefLine(label: string, engineers: string[], families: readonly import("../arm-pr.ts").SpareFamily[]) {
  if (!engineers.includes(label) && familyMember(label, families) === null) return "";
  return `${ENGINEER_BRIEF_SENTENCE}\n\n`;
}

/** The one sentence that sends an engineer to {@link ENGINEER_BRIEF}; a spawned order carries it WITHOUT the roster test (#3444). Its text is `spawn-role-brief.ts`'s (#828). */
const ENGINEER_BRIEF_SENTENCE = engineerBriefSentence(ENGINEER_BRIEF_ABSOLUTE);

/**
 * The prompt as the woken session receives it: the order's text, prefixed with WHO IT IS.
 *
 * THE DEFECT THIS FIXES, seen in production 2026-09-17. `work-gate`'s row order says *"claim it with
 * `row-claim.ts claim <n> --session=<you> --branch=agent/<branch>`"*, and `<you>` is a placeholder no
 * woken agent can resolve. A freshly spawned session has no memory and no assignment: it knows the work
 * but not its own name. The first engineer woken by this system stopped and asked a human which session
 * it was, rather than guess a name and mutate shared GitHub state under it -- which was the RIGHT call
 * on its part and a hole in this one. `wake` has always known the answer: it just routed the order.
 *
 * AND WHO TO ASK, because "ask a human" is the other half of the same hole. `.claude/rules/agent-
 * practices.md` already routes questions -- *"product-manager is the first reader for rows, the queue
 * and process"* -- but a session woken with no context has not necessarily read that yet, and the whole
 * point of this design is that nobody is sitting at that terminal. An agent that blocks on a human it
 * cannot reach is an agent that has stopped.
 *
 * AND, FOR AN ENGINEER ONLY, THE BRIEF TO READ (#2406). No code read `sessions.json`'s `brief` field, and this
 * function named no file under `docs/roles`, so a spawned engineer -- which starts knowing nothing -- was
 * never told the acceptance standard or the resource ban. {@link engineerBriefLine} adds one line for the
 * roster's engineer roles and for no other label.
 *
 * A SPAWNED ENGINEER'S ORDER IS DIFFERENT IN KIND (#2405): its row is already claimed and it is already in the
 * row's worktree, so `spawned` REPLACES the order's text with {@link spawnedPrompt} -- there is no claim command
 * to run and no other directory to name -- AND IT CARRIES NO AUTONOMY PARAGRAPHS (#3444): identity, that text, and the one sentence sending it to
 * `engineer.md`, which says them once ({@link autonomyParagraphs}). A STANDING session keeps the order's own text, with `LAUNCH_PLACEHOLDER`
 * filled by {@link launchAdvice}. `engineers` and `families` are parameters so a test can hand `addressed` a roster.
 *
 * A FOLLOW-UP GETS ONE LINE, NOT THIS WHOLE WRAPPER (#2538). `followUp` is `deliver`'s and `clearThenPrompt`'s say-so that the
 * target was neither started nor cleared for this order, so its window already holds all of the above; the default is the full
 * form, so a caller that does not know is never the one that leaves a session unbriefed. A `spawned` order is never a follow-up.
 *
 * `context` IS WHAT {@link prepareContext} DID TO THIS WINDOW (#3440): it fills {@link CONTEXT_PLACEHOLDER} in a batched order's header,
 * and a kept or compacted STANDING seat's follow-up says its earlier readings are stale ({@link staleReadingsClause}). Absent, the
 * placeholder reads as a clear -- the sentence that was true of every delivery before #3440.
 *
 *
 * @param label the concrete session this went to
 * `briefRole` (#828) is the role brief a SPAWNED seat is sent to, the engineer's by default (byte-identical to the sentence before #828); it is read on the `spawned` branch only, and nothing passes it yet.
 * `blocking` (#4605) is the gate's last count of shelved rows, which `blastTail` turns into the spawned order's `your claim blocks N rows` line; absent, no line, so a caller that does not read it is never the one that invents one.
 * `orderId` (#4068) is the wake id the follow-up header names and the ledger line for this delivery records; see {@link FOLLOW_UP_HEADER}.
 * `model` (#5113) is the model a SPAWNED seat was started on; a Haiku one gets {@link haikuBriefTail} when `workers.haikuBrief` is on, and absent it, nothing is added.
 */
export function addressed(order: { session: string; prompt: string; title?: string; causeKey?: string; cause?: string; }, label: string,
  { spawned, followUp = false, context, orderId, blocking = null, now = Date.now(), engineers = engineerRoles(), families = SPARE_FAMILIES,
    briefRole = "engineer", model, ...launch }: LaunchFacts & {
      spawned?: ClaimedRow; followUp?: boolean; context?: string; orderId?: string; engineers?: string[]; blocking?: BlockingRecord | null; now?: number; model?: string;
      families?: readonly import("../arm-pr.ts").SpareFamily[]; briefRole?: string;
  } = {}) {
  // `<you>` SUBSTITUTED, not merely explained: the order's own command text carries the placeholder, and
  // an agent that has been told its name still has to edit the command it was handed. Handing it a
  // command it can run is the difference between an instruction and a task.
  const prompt = spawned ? spawnedPrompt(order, spawned)
    : order.prompt.replaceAll("<you>", label).replaceAll(LAUNCH_PLACEHOLDER, launchAdvice(label, launch))
      .replaceAll(CONTEXT_PLACEHOLDER, contextSentence(context));
  if (followUp && !spawned) return `${FOLLOW_UP_HEADER(label, { orderId, cause: order.cause })}${staleReadingsClause(label, context)}\n\n${prompt}`;
  const identity = `You are \`${label}\`, an org session in this repository. Use that name wherever a command `
    + `asks which session you are (\`--session=${label}\`).\n\n`;
  if (spawned) {
    const brief = briefRole === "engineer" ? ENGINEER_BRIEF_SENTENCE : briefRoleSentence(briefRole);
    return `${identity}${prompt}\n\n${brief}${calmTail(spawned.row)}${tripsTail(spawned.row)}${blastTail(spawned.row, blocking, now)}${haikuBriefTail(model)}`;
  }
  return `${identity}${prompt}\n\n${engineerBriefLine(label, engineers, families)}${autonomyParagraphs(order, label)}`;
}

/**
 * THE CALM FINISH PARAGRAPH, LAST, FOR A `calm`-ARM ROW'S FIRST-CONTACT PREAMBLE AND NOTHING ELSE (#4070, #4055 move 2): empty for a `control` row, so
 * the two arms' preambles are byte-identical up to it, and a follow-up never reaches this (`addressed` returns before). The arm is {@link armOf}'s.
 */
function calmTail(row: number) {
  return armOf(row) === ARM.CALM ? `\n\n${CALM_FINISH_PARAGRAPH}` : "";
}

/**
 * THE ROUND-TRIPS PARAGRAPH, AFTER THE CALM ONE, FOR A `batched`-ARM ROW'S FIRST-CONTACT PREAMBLE AND NOTHING ELSE (#4182): empty for a `control` row, so a
 * control row's preamble is byte-identical to the calm A/B's. The arm is {@link tripsArmOf}'s, assigned from a different bit of the row number than {@link armOf}'s.
 */
function tripsTail(row: number) {
  return tripsArmOf(row) === TRIPS_ARM.BATCHED ? `\n\n${ROUND_TRIPS_PARAGRAPH}` : "";
}

/**
 * THE THREE PARAGRAPHS A STANDING SEAT AND A REVIEWER READ AFTER THE ORDER, EVERY FIRST ORDER (#3444): autonomy, the end-of-turn rule and
 * what to do when the action is not yours. A spawned engineer is NOT given them: they live in `engineer.md` ({@link ENGINEER_BRIEF}) once
 * and the one sentence above sends it there, so the order does not repeat what it tells the engineer to read.
 *
 * THE STORY BEHIND THE END-OF-TURN RULE, moved here from the order (#3444) where it was read on every delivery by an agent that cannot
 * use it: on 2026-09-21 `product-manager` ended two consecutive turns asking permission to file a COMPLETE, EVIDENCED ROW DRAFT (two
 * incidents, commit hashes, timestamps) -- filing being the first line of its own brief -- and the row did not get filed.
 */
function autonomyParagraphs(order: { session: string; cause?: string; }, label: string) {
  return "Work autonomously to the end: nobody is at this terminal to answer you. If something genuinely "
    + `blocks you, say so on the row and message \`${escalationFor(label)}\` -- never stop and wait on a `
    + `human. ${isReviewerOrder(order) ? REVIEWER_CLAIMS_NO_ROW : REFUSED_CLAIM_IS_AN_ANSWER}\n\n`
    + "ENDING YOUR TURN WITH A QUESTION IS THE SAME AS STOPPING. Nobody reads this terminal, so "
    + "\"want me to file it?\" and not filing it are the same outcome -- except the first also looks "
    + "like progress. IF THE ACTION IS IN YOUR LANE, TAKE IT AND REPORT WHAT YOU DID.\n"
    + "IF IT IS GENUINELY NOT YOURS, that is not a question either: say what you would do, name who "
    + `owns it, and route it -- \`${ANSWER_PREFIX}<session>\` on the row for a ruling, or the row itself for work. `
    + "Then end your turn. The gate will bring you back when something changes; waiting is never your "
    + "job, and polling a pull request for a verdict that has its own cause is a turn spent on a "
    + "question the tick already answers.";
}

/**
 * THE ONE LINE A FOLLOW-UP CARRIES IN PLACE OF THE FIRST-CONTACT PREAMBLE (#2538). `deliver` and `clearThenPrompt` send it
 * to a session whose context they did NOT just start or clear -- a per-row instance mid-row, or a resume (#2470) -- where the
 * preamble is already in the window and a repeat is a copy that stays: ~1,640 chars per order, four copies on a PR with three
 * review rounds.
 *
 * IT IS AN ORDER ID, NOT AN IDENTITY SENTENCE (#4068, #4055 move 5): `[order:<wake id> session:<session> cause:<cause>]`. The session
 * already knows who it is; what no order carried was an id the ledger's line for it can be joined to a turn by. `token-audit`'s
 * `sessionOf` reads `session:` from this header, and still reads the old "You are \`<session>\`" phrase, so a transcript that opens on
 * either form stays attributed. `order:` is left out when the caller has no ledger line to name (a `prompt:session` order is typed by a
 * person or a peer and is never recorded), rather than carrying an id that joins nothing.
 */
const FOLLOW_UP_HEADER = (label: string, { orderId, cause }: { orderId?: string; cause?: string; } = {}) => {
  const fields = [...(orderId ? [["order", orderId]] : []), ["session", label], ["cause", headerToken(cause)]];
  return `[${fields.map(([name, value]) => `${name}:${value}`).join(" ")}]`;
};

/** A header field is one token: a cause with a space or a bracket in it would end the header early for `sessionOf`. */
const headerToken = (value: string | undefined) => (value ?? "").replace(/[\s\]]+/g, "-") || "none";

/** The wake id a delivery's order header and its ledger line share: `wake:<session>:<epoch ms>`, the trace store's own spelling (#4068). */
export const wakeIdOf = (label: string, at: number) => `wake:${label}:${at}`;

/** Where {@link addressed} writes what THIS delivery did to the window into an order whose text was composed before the delivery (#3440). */
export const CONTEXT_PLACEHOLDER = "@@CONTEXT@@";

/**
 * WHAT THIS DELIVERY DID TO THE WINDOW, in the words an order's header quotes (#3440). The sentence "each delivery clears your context
 * first" was true of every standing delivery until a recent window was kept, and is false of a kept one, so it is said per delivery.
 * @param context a {@link CONTEXT_ACTION} value; absent reads as a clear, as it did before #3440
 */
function contextSentence(context: string | undefined) {
  if (context === CONTEXT_ACTION.KEPT) return "THIS DELIVERY KEPT YOUR CONTEXT (your previous order was recent and your window is small).";
  if (context === CONTEXT_ACTION.COMPACTED) return "THIS DELIVERY COMPACTED YOUR CONTEXT (your previous order was recent and your window is large): a summary of it remains.";
  return "THIS DELIVERY CLEARED YOUR CONTEXT first, so what a previous order built is gone.";
}

/**
 * ONE CLAUSE FOR A STANDING SEAT WHOSE WINDOW WAS KEPT (#3440): it holds readings from earlier turns, and acting on an hour-old reading
 * of a row is the failure the clear used to prevent for free. A per-row instance's follow-up is unchanged byte for byte (#2483).
 */
function staleReadingsClause(label: string, context: string | undefined) {
  const kept = context === CONTEXT_ACTION.KEPT || context === CONTEXT_ACTION.COMPACTED;
  if (!kept || isPerRowInstance(label)) return "";
  return " Your window was NOT cleared, so what it holds from earlier turns is a reading at a moment: re-read the row, the PR and the API before acting on it.";
}

/** What a session that must claim its row is told about a refusal; a spawned one has nothing left to claim (#2405). */
const REFUSED_CLAIM_IS_AN_ANSWER = "If you cannot claim the row (already taken, or the claim refuses), that is an "
  + "answer: report it and stop, rather than working outside a claim.";

/**
 * A REVIEWER CLAIMS NO ROW (#2590), so the sentence above is the opposite of its job: `reviewer-2584` ran `row-claim claim 2556`, was
 * refused because the PR's own author still held the claim -- the normal state -- and ended its turn without a verdict.
 */
const REVIEWER_CLAIMS_NO_ROW = "You claim no row, and the author's claim on it is not a blocker: review the pull request.";

/**
 * How long to let a `/clear` land before typing the order after it.
 *
 * A DELAY, NOT A SYNCHRONISATION PRIMITIVE, and named honestly because there is nothing to synchronise
 * on: `/clear` moves neither the agent's status nor its `state_change_seq`. Measured on the live org,
 * 2s and 5s both produced clean prompts where 0s produced `Unknown command: /clearYou are...`. Five is
 * the one with margin, and it costs five seconds of a tick that runs every two minutes.
 */
export const CLEAR_SETTLE_MS = 5_000;

/** `/clear`'s refusal is reported inside a longer sentence, so it quotes less of the failure. */
const CLEAR_REFUSAL_EXCERPT = 80;

/**
 * SUBMIT A COMMAND, SETTLE, RETURN -- the shape behind both `/clear` ({@link clearContext}) and `/compact`
 * ({@link compactContext}), because the reason to wait is the same for either: neither moves the agent's
 * status or its `state_change_seq`, so there is nothing to wait FOR but a bounded delay (see
 * {@link clearContext}'s own comment for the measurement that set it).
 *
 *
 * @returns a refusal to report, or `null` when the command landed
 */
function settleAfter(run: (args: string[]) => string, label: string, command: string, sleep: (ms: number) => void): string | null {
  try {
    // SUBMIT, SETTLE, THEN THE ORDER -- AND THE SETTLE IS A DELAY BECAUSE THERE IS NO SIGNAL.
    //
    // `agent prompt` SUBMITS text and returns without waiting for the agent to consume it. Sending the
    // order straight after typed it into the same input the command was still sitting in, and `ceo`
    // received one concatenated line:
    //
    //     Unknown command: /clearYou are `ceo`, an org session in this repository...
    //
    // TWO REPAIRS FAILED BEFORE THIS ONE, and each failed for its own reason:
    //
    //   `prompt --wait --until idle`   herdr's help: *"--wait first requires an observed state change
    //                                  within 5000ms"*. A `/clear` to an already-`done` agent changes
    //                                  nothing observable, so two of three live wakes returned
    //                                  `agent_prompt_stalled`.
    //   `agent wait --until idle`      an ALREADY-idle agent satisfies it instantly, before it has
    //                                  consumed anything. Still mangled.
    //
    // `state_change_seq` does not move for `/clear` either -- measured, it sat at 6221 across one. Claude
    // Code processes it without any transition herdr can see, and the same is true of `/compact` (#2688):
    // there is nothing to wait FOR. A bounded delay is the honest mechanism, and calling it a delay rather
    // than dressing it as a synchronisation primitive is the point: 2s and 5s both produced clean prompts
    // on the live org, and 5s is the one with margin.
    //
    // The `agent wait` first is still worth its cost: it catches an agent that was mid-turn when the
    // command arrived, where the delay alone would not be enough.
    run(["--session", "org", "agent", "prompt", label, command]);
    run(["--session", "org", "agent", "wait", label, "--until", "idle", "--until", "done",
      "--timeout", String(CLEAR_TIMEOUT_MS)]);
    sleep(CLEAR_SETTLE_MS);
    return null;
  } catch (err) {
    // A REFUSED COMMAND IS NOT A REFUSED WAKE. The order still goes, on a context this command would have
    // shrunk: expensive is strictly better than undelivered, and the refusal is reported rather than
    // swallowed.
    // herdr's OWN WORDS (`herdrReason`), not the command we sent: `Command failed: herdr ... agent prompt X /compact` named
    // neither `agent_not_found` nor `agent_blocked`, and {@link contextBefore} needs the code to tell a gone agent from a busy one.
    return `${label}: ${command} refused (${herdrReason(err, CLEAR_REFUSAL_EXCERPT)})`;
  }
}

/**
 * WHY EVERY DELIVERY CLEARS FIRST, and it is the largest single saving this system has made.
 *
 * A standing session's context only grows. Measured on the live org, 2026-09-18, within one session:
 *
 *   turn 1    37k cache-read        turn 548   895k cache-read
 *
 * Every turn re-reads the whole accumulated conversation, so turn 548 pays 24 times what turn 1 paid to
 * produce the same few hundred output tokens. Across the org that day: 786M input tokens against 782k
 * output -- a thousand to one -- and 7% of a weekly allowance for a day in which very little shipped.
 * The work was never the cost. Carrying yesterday into every turn was.
 *
 * `/clear` IS THE REPOSITORY'S OWN ANSWER, not an invention: `.claude/rules/agent-practices.md` says
 * *"`/clear` between unrelated topics; a fresh window beats stale history"*. It was a habit nobody could
 * keep because nothing reminded anyone. Here it is mechanical.
 *
 * WHO IS CLEARED, AND WHO IS NOT (#2483). `wake` only ever delivers to a session herdr reports `idle` or
 * `done`, so it is between tasks by definition. What that says about the NEXT order depends on the seat:
 *
 *   a STANDING seat (`ceo`, `product-manager`, `orchestrator`, `worker-capture`, `worker-tooling`,
 *   `worker-judge`) is cleared. Its orders really are unrelated topics -- the exact "unrelated topic" the
 *   rule is about -- and the row is the state (`agent-practices.md` again), so it carries nothing across
 *   tasks worth keeping.
 *
 *   a PER-ROW INSTANCE (a spawned `worker-<n>`, a `reviewer-<n>`; {@link isPerRowInstance}) is NOT. Its one
 *   row is its whole life, so a failing check, a refusal or a conflict on ITS pull request is the SAME task
 *   and not an unrelated one: wiping the window discards exactly what the order is about (chairman, via
 *   `ceo`, 2026-09-25). The cost is bounded by one row's lifetime, which is why `/compact` is not added either.
 *
 * NOT `agent start`. Spawning a fresh worker per cause reaches the same context floor and costs a process
 * restart, a pane at a shell prompt, and a window where the session is neither old nor new. `/clear`
 * reaches the floor -- measured 690k -> 37k on worker-capture -- without any of that.
 *
 * MEASURED, NOT ASSUMED: 690k -> 37k on a real session, an 18x cut in per-turn input.
 *
 * THE SETTLE IS A SEAM, AND THE DEFAULT IS THE REAL SLEEP (#2546). `sleep` is what waits `CLEAR_SETTLE_MS`; production passes
 * nothing and blocks for the measured five seconds, exactly as before. A test that drives a clear for some OTHER
 * property injects a recording fake and does not pay it -- `wake-clear-settle.test.ts` pins the order (clear, wait, settle,
 * order), the exact value, and ONE test with no injection that measures the real delay, so a default that quietly became
 * a no-op is caught there and not by a fast suite going green.
 *
 * THE SUBMIT/SETTLE MECHANISM ITSELF IS {@link settleAfter}, shared with `/compact` ({@link compactContext},
 * #2688): the incident that shaped it, and why the wait is a delay rather than a signal, are on that
 * function rather than repeated here.
 *
 *
 * @param [sleep] blocks for `ms`; real by default
 * @returns a refusal to report, or `null` when the context was reset
 */
export function clearContext(run: (args: string[]) => string, label: string, sleep: (ms: number) => void = sleepSync): string | null {
  return settleAfter(run, label, "/clear", sleep);
}

/**
 * `/compact` BEFORE AN OVER-THRESHOLD INSTANCE'S ORDER (#2688) -- the same submit/settle/order sequence as
 * `clearContext`, and for the same reason: `/compact` returns to a prompt with no observable
 * state-change signal either.
 *
 * ONLY {@link prepareContext} CALLS THIS, for a seat whose window is kept (a per-row instance, a persistent seat) or recent
 * (a standing lead, #3440) and over its threshold. A standing lead that is not recent is `/clear`ed to the floor, which has nothing to compact.
 *
 * COMPACTION KEEPS THE THREAD; A CLEAR DOES NOT. #2483 stands unchanged -- a per-row instance is still
 * never `/clear`ed, because its one row is its whole life and a failing check on its own pull request is
 * the same task, not an unrelated one. `/compact` summarises that same window rather than wiping it.
 *
 *
 * @param [sleep] blocks for `ms`; real by default
 * @returns a refusal to report, or `null` when the command landed
 */
export function compactContext(run: (args: string[]) => string, label: string, sleep: (ms: number) => void = sleepSync): string | null {
  return settleAfter(run, label, "/compact", sleep);
}

/**
 * WHAT HAPPENS TO THE WINDOW BEFORE AN ORDER, FOR EVERY PATH THAT DELIVERS ONE (`deliver` here, `clearThenPrompt` in
 * `prompt-session.ts`): a per-row instance ({@link isPerRowInstance}) and a PERSISTENT seat ({@link isPersistentRole}) keep it and are
 * `/compact`ed over {@link COMPACT_THRESHOLD_TOKENS} (#2483, #2688, #3415); any OTHER standing seat reads the clock second
 * ({@link recentOrderAction}, #3440) -- a persistent seat never reaches it. Both callers go through here, because fixing one leaves the
 * reviewer wiped by its own author.
 *
 * AN UNREADABLE TRANSCRIPT HAS TWO OPPOSITE DEFAULTS, one for each reason a window is kept: an instance's is not assumed large
 * (nothing is sent, #2688), a lead's is not assumed small (it is cleared, #3440), because each is the one that costs less when the reading is wrong.
 *
 *
 *
 *   `sleep` is `clearContext`'s settle, passed on as it came; `contextRoot` is {@link instanceCacheRead}'s transcript root;
 *   `sessions` the roster {@link isPersistentRole} reads; `clock` the seat's last-order record and the time, all injectable
 * @returns what was done ({@link CONTEXT_ACTION}), the refusal of
 *   the command that did it, and why a state file kept a clear from being chosen (#4072)
 */
export function prepareContext(run: (args: string[]) => string, label: string, { sleep, contextRoot, sessions = SESSIONS_FILE, clock = NO_CLOCK }: { sleep?: (ms: number) => void; contextRoot?: string; sessions?: string | URL; clock?: OrderClock; } = {}): { action: string; refusal: string | null; stateRefusal?: string; } {
  const { action, stateRefusal } = keepsContext(label, sessions)
    ? { action: overThreshold(label, contextRoot), stateRefusal: null } : recentOrderAction(label, clock, contextRoot);
  // `stateRefusal` rides along only when there is one, so every caller and test that reads the old two-key shape reads it unchanged.
  const why = stateRefusal === null ? {} : { stateRefusal };
  if (action === CONTEXT_ACTION.CLEARED) return { action, refusal: clearContext(run, label, sleep), ...why };
  if (action === CONTEXT_ACTION.COMPACTED) return { action, refusal: compactContext(run, label, sleep), ...why };
  return { action, refusal: null };
}

/**
 * The order as it is TYPED: a reviewer's carries the sentence naming its verified checkout ({@link withReviewCheckout}).
 */
function carriedOrder(order: { session: string; prompt: string; }, target: { order?: { prompt: string; }; }) {
  return target.order === undefined ? order : { ...order, ...target.order };
}

/**
 * A refusal that says the AGENT IS GONE (herdr's `agent_not_found`), as {@link settleAfter} quotes it. Such an order cannot land at all,
 * so it is UNDELIVERED; every other refusal of a context command leaves a session the prompt can still reach.
 */
const AGENT_ABSENT = /agent_not_found/;

/**
 * WHAT HAPPENS TO THE WINDOW BEFORE THIS ORDER (see {@link prepareContext}): `action` is a {@link CONTEXT_ACTION} value, `note` the
 * refusal of the context command when one was refused and the order still goes, and `undelivered` the refusal that stops it.
 * A process this tick STARTED has nothing to clear, so it is `cleared` without a command; a RESUME (#2470) is `kept` without one,
 * because its whole point is the context the session still has and a clear would wipe exactly what the interrupted turn had built.
 *
 * A REFUSED `/clear` OR `/compact` IS NOT A DELIVERY, AND IS NOT "DELIVERED ANYWAY" EITHER (#3546). The order goes after a refusal
 * that left the session reachable -- a window left big costs more than one cleared, which beats an order not sent -- but the word for
 * that was filed under `refused`, which the tick prints as UNDELIVERED, so one line said both. Now the order has ONE status: the
 * refusal rides on the DELIVERED line as `note`, and the prompt that follows is the real check, whose own refusal is UNDELIVERED. A refusal
 * that says the agent is gone (`agent_not_found`) is the one case where the order cannot land, and it stops here with herdr's words.
 *
 * @param ctx `contextRoot` is {@link instanceCacheRead}'s transcript root (#2688)
 */
function contextBefore(order: { causeKey: string; resume?: boolean; }, { run, sleep, contextRoot, clock, target }: {
        run: (args: string[]) => string; sleep?: (ms: number) => void; contextRoot?: string; clock?: OrderClock;
        target: { label: string; profile?: object; };
    }): { action: string; note: string | null; } | { undelivered: string; } {
  if (order.resume === true) return { action: CONTEXT_ACTION.KEPT, note: null };
  if (target.profile) return { action: CONTEXT_ACTION.CLEARED, note: null };
  const { action, refusal, stateRefusal } = prepareContext(run, target.label, { sleep, contextRoot, clock });
  if (refusal === null) return { action, note: stateRefusal ?? null };
  return AGENT_ABSENT.test(refusal) ? { undelivered: refusal } : { action, note: refusal };
}

// --- #3546: A STARTED AGENT'S FIRST PROMPT IS CONFIRMED SUBMITTED, NOT ASSUMED ---

/**
 * How long a process this tick STARTED may take to report `interactive_ready` before its order is held back, and how long after the
 * prompt it may take to leave `idle` before ONE Enter is sent. Both are 30 s, the chairman's suggestion, and MEASURED against it: on the
 * live org, 2026-10-04, `agent start` returned with `interactive_ready: true` and the prompt took the agent to `working` 0.9 s later
 * (one sample, then the live run recorded on #3546), so 30 s is about thirty times the reading, not a reading itself.
 */
export const READY_BOUND_MS = 30_000;
export const SUBMIT_BOUND_MS = 30_000;

/** After the Enter this gate sent, how long the agent has to leave `idle` before the order is UNDELIVERED. */
export const ENTER_BOUND_MS = 10_000;

/** How often a started agent is re-read while the gate waits on it. */
const START_POLL_MS = 500;

/**
 * THE STATES THAT SAY A PROMPT WAS TAKEN. A prompt typed into the box and never submitted leaves herdr reading `idle` with
 * `state_change_seq` unmoved (measured: typed text, 0.5 s later `idle`, same seq), so "not `idle`" is the observable. A turn that was
 * taken and has already ended reads `done`, which counts: a fast reply must not be mistaken for a lost one.
 */
const PROMPT_TAKEN = new Set(["working", "blocked", "done"]);

/**
 * Read one agent: `{status, ready}`. THROWS when herdr cannot answer, and the caller says what that cost.
 */
export function readAgent(run: (args: string[]) => string, label: string): { status: string; ready: boolean; } {
  const agent = JSON.parse(run(["--session", "org", "agent", "get", label]))?.result?.agent;
  if (agent === undefined) throw new Error("herdr's answer named no agent");
  return { status: String(agent.agent_status), ready: agent.interactive_ready === true };
}

/**
 * Re-read `label` every {@link START_POLL_MS} until `met` holds of what herdr says, or `boundMs` has gone by. The bound is the SUM OF
 * THE WAITS, injected like {@link clearContext}'s settle, so a test does not pay it and a real call is bounded to a little over it.
 *
 *
 * @returns `last` is the final reading, or why there was none
 */
function pollAgent(run: (args: string[]) => string, label: string, { met, boundMs, sleep }: { met: (facts: { status: string; ready: boolean; }) => boolean; boundMs: number; sleep: (ms: number) => void; }): { met: true; } | { met: false; last: string; } {
  let last = "herdr never answered";
  for (let waited = 0; ; waited += START_POLL_MS) {
    try {
      const facts = readAgent(run, label);
      if (met(facts)) return { met: true };
      last = `${facts.status}, interactive_ready=${facts.ready}`;
    } catch (err) {
      last = `unreadable: ${herdrReason(err)}`;
    }
    if (waited >= boundMs) return { met: false, last };
    sleep(START_POLL_MS);
  }
}

/**
 * Has this STARTED agent reached the point where a prompt will be submitted, or why not (#3546, done-when 1)? `agent start` returning is
 * not it: a prompt sent before herdr reports `interactive_ready` can be typed and never submitted. Nothing is typed until it does.
 *
 * @returns why the order is held back, or `null` when the agent is ready
 */
function notReadyWhy(run: (args: string[]) => string, label: string, sleep: (ms: number) => void): string | null {
  const ready = pollAgent(run, label, { met: (f) => f.ready && f.status === "idle", boundMs: READY_BOUND_MS, sleep });
  return ready.met ? null : `"${label}" started but herdr never reported it interactive-ready within ${READY_BOUND_MS / 1000}s `
    + `(${ready.last}); nothing was typed`;
}

/**
 * Did the agent TAKE the prompt just sent (#3546, done-when 2)? Waits {@link SUBMIT_BOUND_MS} for it to leave `idle`; if it has not, the text
 * is in the box unsubmitted (a newline landed where the submit should have), so the gate sends ONE Enter and waits {@link ENTER_BOUND_MS}.
 * The Enter is sent only on that evidence: an agent that went `working` is never sent one, or it would submit an empty line into its first turn.
 *
 * @returns why the order is UNDELIVERED, or `null` when the agent took it
 */
function untakenWhy(run: (args: string[]) => string, label: string, sleep: (ms: number) => void): string | null {
  const taken = (f: { status: string; }) => PROMPT_TAKEN.has(f.status);
  if (pollAgent(run, label, { met: taken, boundMs: SUBMIT_BOUND_MS, sleep }).met) return null;
  try {
    run(["--session", "org", "agent", "send-keys", label, "enter"]);
  } catch (err) {
    return `"${label}" stayed idle ${SUBMIT_BOUND_MS / 1000}s after its prompt and the Enter was refused (${herdrReason(err)})`;
  }
  const after = pollAgent(run, label, { met: taken, boundMs: ENTER_BOUND_MS, sleep });
  return after.met ? null : `"${label}" never started a turn: still ${after.last} ${ENTER_BOUND_MS / 1000}s after one Enter, `
    + `${SUBMIT_BOUND_MS / 1000}s after its prompt`;
}

/**
 * Undo a start whose first prompt did not land: close the workspace this tick opened, and release the row it claimed for the
 * role, so the gate offers the order again as an ORDER (the row reads unclaimed, a fresh process is started) and not as a second copy typed
 * on top of the text already in this one's box. The same two undos {@link spawnWorker} makes when the start itself fails.
 *
 *
 * @returns a clause to append to the refusal being reported
 */
function abandonedStart(target: { label: string; workspace?: string; claimed?: ClaimedRow; }, { run, claimer, env }: { run: (args: string[]) => string; claimer?: SpawnClaimer; env?: Record<string, string>; }): string {
  const closed = target.workspace === undefined ? "" : closedNote(run, target.workspace);
  const released = target.claimed !== undefined && claimer !== undefined
    ? claimer.release(target.claimed, target.label, env ?? spawnEnvironment()) : "";
  return `${closed}${released}`;
}

/**
 * IS THIS ORDER A FOLLOW-UP, whose session already holds the first-contact preamble (#2538)? Only a target that was neither
 * started this tick (`profile`) nor cleared before the order does. A resume is kept too, but a process this tick STARTED for one is
 * new and knows nothing, so it is briefed however it was ordered.
 *  @param context a {@link CONTEXT_ACTION} value
 */
function isFollowUp(target: { profile?: object; }, context: string) {
  return context !== CONTEXT_ACTION.CLEARED && target.profile === undefined;
}

/**
 * Type the order into `target` and, for a process this tick STARTED, make sure it was TAKEN (#3546).
 *
 * A STARTED AGENT IS PROMPTED ONLY ONCE herdr reports it interactive-ready ({@link notReadyWhy}), and the prompt is CONFIRMED by the agent
 * leaving `idle` ({@link untakenWhy}), with one Enter if it did not. Either failure ABANDONS the start ({@link abandonedStart}): the order
 * is UNDELIVERED with the reason, never STARTED. A refused prompt keeps the old behaviour -- the process is left running for the next tick's
 * `route` -- because nothing was typed into it. A standing session or a live instance is prompted exactly as before: it is not new, and its
 * prompt is not the first thing its terminal has been asked.
 *
 *
 *
 * @param how `orderId` is the wake id the follow-up header names (#4068)
 * @returns why the order is UNDELIVERED, or `null` when it landed
 */
export function promptTarget(order: { causeKey: string; session: string; prompt: string; briefRole?: string; }, target: { label: string; profile?: object; claimed?: ClaimedRow; workspace?: string; order?: { prompt: string; }; }, { run, sleep = sleepSync, launch, context, claimer, env, orderId, blocking = () => readBlockingRecord(stateEntryPath("")) }: {
        run: (args: string[]) => string; sleep?: (ms: number) => void; launch?: LaunchFacts; context: string;
        claimer?: SpawnClaimer; env?: Record<string, string>; orderId?: string; blocking?: () => BlockingRecord | null;
    }): string | null {
  const started = target.profile !== undefined;
  const notReady = started ? notReadyWhy(run, target.label, sleep) : null;
  if (notReady !== null) return `${notReady}${abandonedStart(target, { run, claimer, env })}`;
  try {
    run(["--session", "org", "agent", "prompt", target.label,
      addressed(carriedOrder(order, target), target.label,
        { ...launch, spawned: target.claimed, followUp: isFollowUp(target, context), context, orderId, blocking: blocking(), model: (target.profile as { model?: string } | undefined)?.model,
          // #832: the brief a ONE-SHOT order names; absent on every other order, and `addressed`'s default is then the engineer's, byte for byte.
          briefRole: order.briefRole })]);
  } catch (err) {
    // A STARTED PROCESS IS LEFT RUNNING HERE, and the causeKey is NOT recorded. It is a healthy, idle
    // session under a roster label, so the next tick's `route` offers it this same order by the ordinary
    // path; closing it would throw away a working engineer to tidy up a failed prompt.
    return `herdr refused the prompt to "${target.label}" (${firstLine(err)})`;
  }
  const untaken = started ? untakenWhy(run, target.label, sleep) : null;
  return untaken === null ? null : `${untaken}${abandonedStart(target, { run, claimer, env })}`;
}

/** The tick-log suffix of a numbered repeat order. */
function continuationNote(continuation: { number: number; escalated: boolean; } | null) {
  if (continuation === null) return "";
  return ` [continuation ${continuation.number}${continuation.escalated ? ` -> ${CONTINUATION_ESCALATE_TO}` : ""}]`;
}

/**
 * WHAT A LANDED DELIVERY WRITES TO THE CLAIM-ORDERS RECORD (#4070): one `continuation` line for a numbered repeat order (claim, cause, number, and who
 * got it), and one `arm` line for a worker this delivery STARTED -- written at the spawn, once, so a report groups by arm without recomputing it. The line carries BOTH
 * arms (`arm`, the calm A/B's, and `tripsArm`, the round-trips A/B's, #4182), so the 2 by 2 is read from one record.
 */
function noteClaimOrders(claimOrders: ClaimOrders | undefined, { gateOrder, target, continuation, at }: {
        gateOrder: { session: string; cause?: string; causeKey: string; }; target: { label: string; profile?: { model?: string; }; claimed?: ClaimedRow; };
        continuation: { claim: string; number: number; } | null; at: number;
    }) {
  if (claimOrders === undefined) return;
  if (continuation !== null) {
    claimOrders.counts.set(continuation.claim, continuation.number);
    claimOrders.append({ kind: "continuation", at, claim: continuation.claim, cause: gateOrder.cause, continuation: continuation.number,
      session: gateOrder.session, to: target.label, causeKey: gateOrder.causeKey });
  }
  if (target.profile !== undefined && target.claimed !== undefined) {
    // `model` (#4630) is what the worker STARTED on, so the escalation reads it from the record and never from the row's label, which a restart does not change.
    claimOrders.append({ kind: "arm", at, session: target.label, row: target.claimed.row, ...(target.claimed.key ? { key: target.claimed.key } : {}), arm: armOf(target.claimed.row),
      tripsArm: tripsArmOf(target.claimed.row), model: target.profile.model });
  }
}

/**
 * Deliver each order, and say what happened to every one of them.
 *
 * REPORTS BEFORE IT RECORDS. An order is written to the ledger only once herdr has accepted it, so a crash
 * between the two re-wakes rather than losing the wake. Re-waking is visible and costs one turn; losing one
 * is invisible and costs however long until someone notices -- the 2026-09-08 shape.
 *
 *
 *   `resume` (#2470) sends the prompt WITHOUT the `/clear` a standing seat is otherwise given first; `outageNow`
 *   (#2685) is `work-gate.ts`'s reading that GitHub itself refused several of THIS TICK's own reads together
 *
 *
 *
 *   `relane` (#3465) is {@link relaneTarget}'s clock and the deferral record: a declared finishing order over the bound goes to a free engineer. Absent, none is re-laned.
 *   `clock` is the standing seats' last-order record and the time ({@link OrderClock}, #3440); absent, no seat's window is kept for
 *   being recent. `sleep` is the clear's settle ({@link clearContext}): real by default, injected only by a test that is not about the delay (#2546);
 *   `contextRoot` is {@link instanceCacheRead}'s transcript root (#2688), real `~/.claude/projects` by default, injected only by a test;
 *   `unavailable` says why a session cannot ANSWER now (`unavailableReason`), and an order to one is refused with that
 *   reason and neither sent nor recorded (#2256); `registerReviewer` is told of every reviewer instance this tick starts (#2401), for the auth detector;
 *   `checkout` and `registry` are the reviewer path's seams (its git, its filesystem, what it has started);
 *   `registerSpawn` is told of every process this tick STARTS, so the teardown can tell an instance that has
 *   not claimed yet from one that finished ({@link endFinishedSpares}); `drained` is the roles the drain holds
 *   back now, which a spawn must not start into; `claimable` is the spawn's precheck ({@link spawnClaimability});
 *   `claimer` claims the row for a spawn before its pane opens ({@link spawnClaimer}); `memory` is the hold
 *   for a host short of memory, asked before either kind of NEW process (#2508); `launch` is what `addressed`
 *   asks about a standing session's worktree; `codexConfig` reads the reviewer's codex config for a keyed reviewer's trust note (#3264);
 *   `now` is the clock that mints each delivery's order id, which `record` receives as `at` (#4068);
 *   `claimOrders` (#4070) is {@link claimOrdersIn}'s record: the arm of every worker this call STARTS is written to it, and the nth repeat order to a live
 *   worker's claim is numbered, logged and, from the {@link MAX_CONTINUATIONS}th on, sent to {@link CONTINUATION_ESCALATE_TO}. Absent, no order is counted or capped
 *
 *   `settled` (#3568) is one line per order addressed to a seat that ended this tick -- DROPPED (derived) or LEFT QUEUED (authored) -- and is not a refusal;
 *   `goneSeats` is every seat the tick found ended, label to the reason, for the next delivery of the same tick
 *   `outaged` (#2685) is `stuck`'s OWN shape -- capped at `MAX_DELIVERIES`, not retried -- for a causeKey work-gate
 *   marked `outageNow`: several of THIS TICK's own reads were refused together, so several causes reaching the cap
 *   in the same run share ONE reason and must not each reach `escalateStuck` as if they were N unrelated stuck rows.
 */
export function deliver(orders: readonly { session: string; causeKey: string; prompt: string; cause?: string; title?: string; replaces?: { branch: string; }[]; resume?: boolean; outageNow?: boolean; startFresh?: boolean; briefRole?: string; trust?: ReviewTrust; }[], agents: { label: string; status: string; }[], roster: string[],
  { run = defaultRun, record, counts, ineligibleReason, env, registerSpawn, drained, claimable, claimer, memory, hostLoad, claimRefused, oneShot, ceoOneShot,
    launch, reviewerEnv, reviewerToken, registerReviewer, checkout, registry, unavailable, sleep, contextRoot, codexConfig, clock, relane, goneSeats, claimOrders, toolchain,
    reviewerRefresh, now = Date.now, serve, accountPause, endRun }: {
          run?: (args: string[]) => string; record?: (key: string, recipient?: string, options?: { noClear?: boolean; }, at?: number) => void;
          /** agent-org#1392: writes the RESET that ends a capped cause's run when its absent seat is started again (see `isAbsentReviewerSeat`). */
          endRun?: (causeKey: string, at: number) => void;
          /** agent-org#1307: the account's pause for this tick; while it holds, no Claude seat is started, claimed for or prompted, and no `claude -p` run is served. */
          accountPause?: AccountLimit | null;
          serve?: (order: { causeKey: string; }) => ServedRecord | null;
          counts?: Map<string, number>; ineligibleReason?: (label: string) => string | null;
          env?: Record<string, string>; registerSpawn?: (role: string) => void; drained?: readonly string[];
          claimable?: (order: { causeKey: string; startFresh?: boolean; }) => string | null; claimer?: SpawnClaimer; claimRefused?: ClaimRefused; oneShot?: OrchestratorOneShot; ceoOneShot?: CeoOneShot;
          memory?: () => string | null; hostLoad?: () => HostLoad; launch?: LaunchFacts; unavailable?: (label: string) => string | null;
          sleep?: (ms: number) => void; contextRoot?: string; clock?: OrderClock;
          relane?: { deferredSince: Map<string, number>; now: number; }; goneSeats?: ReadonlyMap<string, string>; now?: () => number;
          claimOrders?: ClaimOrders; toolchain?: ToolchainGate;
          /** agent-org#1348: keeps each live reviewer's token past its margin, every tick; returns the reason each refresh failed, labelled. */
          reviewerRefresh?: (live: { label: string; status: string; }[]) => string[];
      } & Partial<ReviewerDeps> = {}): { sent: string[]; refused: string[]; stuck: string[]; outaged: string[]; settled: string[]; goneSeats: Map<string, string>; tokenFailures: string[]; } {
  const sent = [];
  const refused = [];
  const settled: string[] = [];
  // #3568: A SEAT THAT ENDED -- released earlier in this tick, or refused with `agent_not_found` by herdr -- IS NOT IN `live`, so no order is routed to it and
  // herdr is not called about it again. Its pool orders go to a free engineer, and what is addressed to it BY NAME is settled by {@link endedSeatLine}.
  const gone = new Map(goneSeats ?? []);
  const stuck: string[] = [];
  const outaged: string[] = [];
  const live = agents.filter((a) => !gone.has(a.label)).map((a) => ({ ...a }));
  let spawned = 0;
  // agent-org#1348: THE TICK KEEPS EACH LIVE REVIEWER'S TOKEN PAST ITS MARGIN, here at the top of every tick and not only when an order is delivered, so a
  // reviewer that is running through a quiet stretch does not reach its expiry with nothing refreshing it.
  const tokenFailures = reviewerRefresh?.(agents) ?? [];
  // agent-org#1025: ONLY `agent start` IS TIMED, and only the spawn paths below use this `run`; the context and prompt calls keep the caller's.
  const starts = startBudgetOf(now);
  const spawnRun = starts.timed(run);
  // #1311: THE OUTSIDE VERDICTS ARE POSTED FIRST, from the panes their reviewers wrote, so a verdict is not held behind this tick's other orders. A
  // failure to read them is one line, not a stopped tick: the verdict is posted on a later tick, since the block stays in the pane.
  try {
    settled.push(...postOutsideVerdictsOf(registry?.() ?? {}, run));
  } catch (err) {
    settled.push(`outside verdicts not read this tick: ${firstLine(err)}`);
  }
  for (const gateOrder of orders) {
    // A REPEAT ORDER TO A LIVE WORKER'S CLAIM IS NUMBERED BEFORE IT IS ROUTED (#4070), and the cap's order is the one that is routed, so everything below reads `order`.
    const continuation = continuationOf(gateOrder, live, roster, claimOrders);
    const order = continuation?.escalated ? escalatedContinuation(gateOrder, continuation) : gateOrder;
    // A CAUSE THAT KEEPS COMING BACK IS NOT A TIMING PROBLEM. Offering it a seventh time would be the
    // silent-retry version of the bug this whole change fixes -- work going nowhere while the log looks
    // busy. Naming it and stopping is the only answer that reaches a person.
    const already = counts?.get(order.causeKey) ?? 0;
    // agent-org#1392: A CAPPED CAUSE WHOSE SEAT IS ABSENT IS STARTED AGAIN, NOT CAPPED. The cap counted deliveries to a seat that is gone, and no
    // run of it can end while the seat is absent. Its RESET is written only when the order is placed (below), so a refused order keeps its count.
    const restart = already >= MAX_DELIVERIES && isAbsentReviewerSeat(order.session, { registry: registry?.() ?? {}, agents });
    if (already >= MAX_DELIVERIES && !restart) {
      recordCapped({ stuck, outaged }, order, already);
      continue;
    }
    // agent-org#904: AN ORDER A RUN SERVED THIS TICK IS NOT PROMPTED TO ITS SEAT. `serve` is the answer `serveOrdersByRun` already holds (a run is asynchronous and this loop is not),
    // and it is absent, or `null` for an order, unless the project set that order's class to `run` and the run APPLIED its decision. The delivery is recorded like any other, so the
    // gate does not derive the cause again for the wake window and the cap above counts it; every other order, and every fallback, goes on to the seat below unchanged.
    // agent-org#1307: WHILE THE ACCOUNT'S PAUSE HOLDS, A RUN IS NOT SERVED EITHER: a `claude -p` decision is a Claude start, and the order is refused below.
    const servedByRun = accountPause ? null : (serve?.(order) ?? null);
    if (servedByRun !== null) {
      record?.(order.causeKey, undefined, undefined, now());
      sent.push(`${order.session} <- ${order.causeKey} (SERVED BY RUN ${servedByRun.runId} at ${servedByRun.tier})`);
      continue;
    }
    const target = targetFor(order, live, roster, { run: spawnRun, spawned, ineligibleReason, env, registerSpawn, drained, startHold: starts.hold,
      claimable, claimer, memory, hostLoad, claimRefused, oneShot, ceoOneShot, reviewerEnv, reviewerToken, registerReviewer, checkout, registry, codexConfig, relane, goneSeats: gone, toolchain, accountPause });
    if ("refusal" in target) {
      const left = endedSeatLine(order, gone);
      if (left === null) refused.push(`${order.causeKey}: ${target.refusal}`); else settled.push(left);
      continue;
    }
    // A SESSION OUT OF ALLOWANCE IS NOT DELIVERED TO (#2256), for the reason a `blocked` one is not: a prompt typed into it
    // is answered by the same limit message, and the ledger would count it as an answer given. Six such counts tripped the
    // breaker overnight 2026-09-23/24 on eleven causes and put two rows in the chairman's inbox for an outage. A process
    // this tick started has a fresh allowance question no transcript can answer yet, so it is not asked.
    const unavailableWhy = whyUnavailable(target, unavailable);
    if (unavailableWhy !== null) {
      refused.push(`${order.causeKey}: ${unavailableWhy}`);
      continue;
    }
    // A PROCESS THAT HAS EXISTED FOR TWO SECONDS HAS NOTHING TO CLEAR, and `/clear` is not free: it is a
    // prompt, a bounded wait and a five-second settle (`CLEAR_SETTLE_MS`) before the order can be typed.
    // Spending that on a session whose context is its own prefix would be paying the standing path's cost
    // to reach a floor the spawn already started at -- which is the whole argument for spawning.
    spawned += engineerStarts(target);
    // CLEARED BEFORE PROMPTED, except a per-row instance (#2483) and a standing lead whose previous order was recent (#3440). See
    // `clearContext` for the measurement and for who is cleared: a standing seat's 500th turn costs ~24x its 10th for identical
    // output, an instance's window is its one row.
    // A RESUME IS NEVER PRECEDED BY A CLEAR (#2470): its whole point is the context the session still has. Sent to a standing seat it
    // would wipe exactly what the interrupted turn had built, and the ledger says so with the same `no-clear` mark an instance's carries.
    const before = contextBefore(order, { run, sleep, contextRoot, clock, target });
    if ("undelivered" in before) {
      refused.push(`${order.causeKey}: ${before.undelivered}`);
      noteGoneSeat(live, gone, target.label, before.undelivered);
      continue;
    }
    const { action: context, note } = before;
    const noClear = context !== CONTEXT_ACTION.CLEARED;
    // THE ORDER ID IS THE LEDGER LINE'S OWN TIMESTAMP, minted before the prompt and handed to `record` after it (#4068): the id typed into the
    // header and the id the ledger records for this delivery are one number, so a turn's header joins its line exactly.
    const at = now();
    const failure = promptTarget(order, target, { run, sleep, launch, context, claimer, env, orderId: wakeIdOf(target.label, at) });
    if (failure !== null) {
      refused.push(`${order.causeKey}: ${failure}`);
      noteGoneSeat(live, gone, target.label, failure);
      continue;
    }
    // Woken agents are working NOW, so a second order in this same tick must not go to the same one. A
    // session this tick STARTED is not in `live` at all, so it is added rather than updated -- without
    // this, the next refused order in the same tick would find that role absent and start a second
    // process under a label herdr has just taken.
    const entry = live.find((a) => a.label === target.label);
    if (entry) entry.status = "working";
    else live.push({ label: target.label, status: "working" });
    // THE TIME THIS ORDER LANDED IS WHAT THE NEXT ONE'S KEEP-OR-CLEAR READS (#3440), so it is written only after the prompt did.
    if (!target.profile) clock?.recordOrder(target.label);
    // A POOL ORDER'S RECIPIENT IS RECORDED (#2226): its causeKey names `engineers`, so the ledger alone could
    // not say who was woken, and the only account of a wrong delivery was the recipient's own prose. A NAMED
    // order's recipient is already in its key and is not repeated.
    // A FALLBACK DELIVERY IS RECORDED THE SAME WAY (#2356): the key names the session it was ADDRESSED to.
    // THE RESTART'S RESET COMES BEFORE ITS DELIVERY LINE (#1392): the next tick counts from the reset, not from the seventh delivery.
    if (restart) endRun?.(order.causeKey, at);
    if (record) record(order.causeKey, target.label !== gateOrder.session ? target.label : undefined, { noClear }, at);
    noteClaimOrders(claimOrders, { gateOrder, target, continuation, at });
    // WHETHER A CLEAR WAS SENT IS READABLE (#2483): a STARTED line has no history to clear, a standing seat's
    // line is unchanged, and an instance's says it was left alone -- so the tick log shows no `/clear` to one.
    sent.push(target.profile
      ? `${target.label} <- ${order.causeKey} (STARTED ${target.profile.model}/${target.profile.effort})`
      : `${target.label} <- ${order.causeKey}${noClear ? NO_CLEAR_NOTE : ""}${note === null ? "" : ` [${note}]`}${continuationNote(continuation)}`);
  }
  return { sent, refused, stuck, outaged, settled, goneSeats: gone, tokenFailures };
}

/**
 * #3568: A SEAT HERDR SAYS IS GONE IS LEFT OUT OF EVERY LATER ORDER OF THE TICK. `refusal` is herdr's own words, and only `agent_not_found` ({@link AGENT_ABSENT}) is
 * "gone": a busy or blocked seat still exists and keeps its place. One call that found the seat missing is the whole cost -- the tick of 2026-10-04T21:49Z asked herdr
 * about `worker-2702` seven times and every answer was the first one. A seat that DIES BETWEEN the roster read and the prompt still costs that one refusal, and says so.
 * @param live mutated: the seat leaves it @param gone mutated: the seat joins it
 */
function noteGoneSeat(live: { label: string; status: string; }[], gone: Map<string, string>, label: string, refusal: string) {
  if (!AGENT_ABSENT.test(refusal)) return;
  gone.set(label, firstLine(refusal));
  const at = live.findIndex((a) => a.label === label);
  if (at >= 0) live.splice(at, 1);
}

/**
 * The repository a tracker KEY names in the project's declaration, or `null` for a key it does not declare -- which the caller reads as
 * "cannot tell", never as the first tracker's repository (#4685). The row lives in the TRACKER, which is not always the code repository
 * ({@link codeRepositoryOf}), so the tracker list answers.
 */
export function trackerRepositoryOf(key: string): string | null {
  return homeProjectDeclaration().tracker.find((tracker) => tracker.key === key)?.repo ?? null;
}

// --- #2405: A SPAWNED ENGINEER STARTS IN ITS ROW'S WORKTREE, BECAUSE THE SPAWNER CLAIMED THE ROW FIRST ---
//
// Measured by the chairman watching `worker-6` on 2026-09-24 and re-read at `a7a91408a`: the pane opened in the
// primary checkout, which `launchGate` refuses, and its order named `role-worker-6`, which did not exist (six of
// the eight engineer addresses have no such directory). The order also offered whichever linked worktree `git
// worktree list` named, which makes a spawned engineer BORROW one -- possibly `role-worker-5` while `worker-5` works in it, two agents' git
// commands in one tree. `ceo` accepted the pre-claim on the chairman's message: this section is the claim, run
// by the spawner as the address it is about to start, from a linked worktree that address owns.

/**
 * The host's layout, which the gate's own order text already hardcoded (`/home/agent/repos/...`): the PRIMARY
 * checkout, and the directory its linked worktrees (`role-<name>`, `wt-<row>`) sit beside it in.
 */
export const HOST_REPOS = "/home/agent/repos";
export const PRIMARY_CHECKOUT = HOME_CHECKOUT;

/**
 * What a STANDING session is told about where to launch the claim from (#2405): `role-<you>` when it EXISTS, and the one
 * command that creates it when it does not -- never a path that is absent, and never a peer's worktree to borrow. The primary is named only to say the tooling refuses it, AFTER the directory to use.
 */
export function launchAdvice(label: string, { exists = existsSync, worktreesDir = HOST_REPOS, primary = PRIMARY_CHECKOUT }: LaunchFacts = {}): string {
  const dir = join(worktreesDir, `role-${label}`);
  const refused = `NOT the primary checkout at \`${primary}\`, which the tooling refuses`;
  if (exists(dir)) {
    return `Run the command from your own linked worktree \`${dir}\` -- ${refused} -- then do all the work inside `
      + "the new worktree.";
  }
  return `You have no linked worktree yet (\`${dir}\` does not exist), so create it and run the command from there: `
    + `\`git -C ${primary} fetch --quiet origin && git -C ${primary} worktree add --detach ${dir} origin/main\` `
    + `-- ${refused} -- then do all the work inside the new worktree.`;
}

/**
 * The order a SPAWNED engineer gets (#2405). The row is already claimed and the pane is already in the worktree the
 * claim created, so the order says both, names no command to run the claim and no directory but that worktree, and
 * sends the engineer straight to building.
 */
export function spawnedPrompt(order: { title?: string; }, claimed: ClaimedRow): string {
  const key = claimed.key ?? "";
  const repo = key === "" ? null : trackerRepositoryOf(key);
  // A KEYED ROW SAYS WHERE IT LIVES (#4685): `#481` alone reads as this repository's row 481. The worktree is of the keyed clone, so `gh issue view`
  // with no `--repo` would read the wrong repository's issue, which is the mistake the sentence exists to prevent.
  const where = key === "" ? "" : ` It is a row of the \`${key}\` tracker${repo === null ? "" : ` (\`${repo}\`)`}, not of this repository's: read it with \`gh issue view ${claimed.row} --repo ${repo ?? `<${key}'s repository>`}\`, and the worktree is of that repository's clone.`;
  return `Row ${rowMention({ key, number: claimed.row })}${order.title ? `: ${order.title}` : ""} has been claimed for you, and you are in its `
    + `worktree \`${claimed.worktree}\` on branch \`${claimed.branch}\`. Build it here: read the row, then do the work `
    + "in this directory. The claim was made before your process started, as your own session, so there is nothing "
    + `left to claim.${where}${adoptedNote(claimed)}${claimed.restart === undefined ? "" : `\n\n${escalationNote({ session: claimed.restart.from, reason: claimed.restart.reason })}`}`;
}

/**
 * THE SENTENCE A RESPAWN INTO A KEPT TREE NEEDS (#2470): the tree is not empty. An instance told only "build it here" would read the row
 * and start again from `origin/main`'s idea of the code, which is exactly the work the release kept.
 */
function adoptedNote(claimed: ClaimedRow): string {
  if (claimed.adopted === undefined) return "";
  const { from, dirty, unpushed, replaces } = claimed.adopted;
  if (replaces) {
    return `\n\nTHIS WORKTREE IS NOT EMPTY, AND ITS PULL REQUEST WAS CLOSED UNMERGED (#3892). It is \`${from}\`'s, on \`${claimed.branch}\`, which \`origin\` already holds; it has ${dirty} changed `
      + `file(s) and ${unpushed} unpushed commit(s). READ THE ROW FIRST for why the pull request was closed, then \`git log origin/main..HEAD\`: the replacement is this work, `
      + "brought up to date and opened with `agent-org pr:open` from this workspace. Do not delete or rename the branch.";
  }
  return `\n\nTHIS WORKTREE IS NOT EMPTY. It is \`${from}\`'s, taken back when that claim stopped moving, and it holds ${dirty} changed `
    + `file(s) and ${unpushed} commit(s) that exist nowhere else. READ \`git status\` AND \`git log origin/main..HEAD\` FIRST and `
    + "continue what is there; do not redo it from the row. If it is wrong or finished, say so on the row and commit or push what is "
    + "worth keeping before you change direction.";
}
