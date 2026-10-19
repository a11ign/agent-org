import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ANSWER_PREFIX } from "../waiting-condition.ts";
import { readReviewerRegistry } from "../work-gate/causes/org-health-reviewer-auth.ts";
import { reviewerInstance } from "../review-attribution.ts";
import { REPO } from "../project-identity.ts";
import { roleBriefPath } from "../project-roles.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";
import { firstLine } from "../herdr-agents.ts";
import { reviewerPathsFrom, type CheckoutDeps } from "./ensure-reviewer-token.ts";
import { CONTEXT_PLACEHOLDER, YOU_PLACEHOLDER_BYTES, authorOf, deliver, fitBatch, isAbsent, orderHeading, readReviewerEndings, waitedFor } from "./fyi-queue.ts";
import { readSpareRegistry, type OrderClock, type SpareCycle } from "./holds-as-fyi.ts";
import { ESCALATED, HANDOFF_STALE_MS, JUDGMENT_TTL_MS, RESET, VOIDED, declaresDecision, dropHandoffs, ledgerKeyOf, queueHandoff } from "./seat-reset.ts";
import { defaultGh, defaultRun } from "./exit-and-limits.ts";

/**
 * WHICH LABELS ARE KNOWN TO HAVE ENDED, and when -- the signal this row names: a TORN-DOWN INSTANCE'S RECORD.
 * `cycles` is the spare ledger (one line per engineer instance {@link endFinishedSpares} closed) and `endings` is
 * the reviewer ledger; each is written by the teardown at the moment it closes a workspace, so a line is a fact
 * that the instance existed and was ended on purpose. It costs two local file reads and NO API call.
 *
 * A LABEL THAT STARTED AGAIN IS NOT ENDED. Spare labels are reused (`nextSpareLabel`), and `registries` hold what
 * each start path has registered and not yet ended: an entry stamped at or after the ending is a later instance
 * under the same name, and the label leaves the map. (`registerSpawn` stamps a failed cycle and the new entry with
 * the same `now`, which is why the comparison is `>=`.)
 *
 * WHAT IS NOT IN THE MAP, ON PURPOSE: a label that was never started (`reviewer-<n>` before the gate starts it),
 * and one registered and then missing with no ending -- closed by hand or crashed, which is a failed cycle for
 * the ledger to say and not a fact this function may act on.
 *
 *
 * @returns label -> when its latest ending was recorded (ms)
 */
export function endedSessions({ cycles, endings, registries }: {
        cycles: { role: string; at: number; }[]; endings: { session: string; at: string; }[];
        registries: Record<string, { spawnedAt: number; }>[];
    }): Map<string, number> {
  const ended: Map<string, number> = new Map();
  const note = (label: unknown, at: number) => {
    if (typeof label !== "string" || label === "?" || !Number.isFinite(at)) return;
    if (at > (ended.get(label) ?? -Infinity)) ended.set(label, at);
  };
  for (const cycle of cycles) note(cycle.role, Number(cycle.at));
  for (const ending of endings) note(ending.session, Date.parse(ending.at));
  for (const registry of registries) {
    for (const [label, started] of Object.entries(registry)) {
      if (started.spawnedAt >= (ended.get(label) ?? Infinity)) ended.delete(label);
    }
  }
  return ended;
}

/**
 * The ended labels, read from the state beside the ledger. THROWS on an unreadable file, and the tick treats that
 * as "no evidence": nothing is dropped on a reading that could not be made.
 */
export function endedSessionsAt(ledgerPath: string, read: typeof readFileSync = readFileSync): Map<string, number> {
  const spares = sparePathsFrom(ledgerPath);
  const reviewers = reviewerPathsFrom(ledgerPath);
  return endedSessions({
    cycles: readSpareCycles(spares.cycles, read),
    endings: readReviewerEndings(reviewers.endings, read),
    registries: [readSpareRegistry(spares.registry, read), readReviewerRegistry(reviewers.registry)],
  });
}

/**
 * ABSENT IS NOT ENDED, and this is the whole trap (#2459 done-when 4). `live`: the workspace exists, so
 * {@link route} decides -- delivered between tasks, refused while busy, exactly as before. `ended`: it does not
 * exist AND a teardown recorded that it was closed. `absent`: it does not exist and nothing says it ever did --
 * `reviewer-<n>` is started by the gate AFTER an order for it may already be queued, so treating every missing
 * label as ended would drop a reviewer's first order.
 *
 * `engineers` is the pool, never a label of its own, and `route` resolves it.
 */
export function targetState(session: string, agents: readonly { label: string; }[], ended: ReadonlyMap<string, number>): "live" | "ended" | "absent" {
  if (!isAbsent(session, agents)) return "live";
  return ended.has(session) ? "ended" : "absent";
}

/**
 * The rows and pull requests an order names, as `#<n>`, first appearance first. A bare `#<n>` only: a hash inside a
 * word, a path or a URL fragment is not a reference.
 */
export function namedRefs(prompt: string): number[] {
  return [...new Set([...prompt.matchAll(/(?<![\w/&#])#([1-9][0-9]*)\b/g)].map((m) => Number(m[1])))];
}

/** How many of an order's references are looked up: the order names its subject early, and every lookup is an API call. */
const MAX_REFS_LOOKED_UP = 3;

/**
 * WHO NOW HOLDS WHAT THE ORDER IS ABOUT, or why nobody does. The order's first references are asked of
 * `holder` -- an OPEN row or pull request carrying a `session:` label naming a session that is live -- and the first
 * to have one is where the order goes. A reference that is closed, or held by nobody live, is skipped.
 *
 * A LOOKUP THAT CANNOT ASK ENDS NOTHING: `holder` answers `null` for a GitHub that would not say, and that is
 * `unknown`, never `none` -- an order is dropped only when GitHub said nobody holds what it names.
 *
 * THE AUTHOR IS NOT AN ADDRESSEE (#2853): an order whose only live holder is the session that WROTE it is `author`,
 * and is dropped -- `worker-2783` wrote an order for `reviewer-2826`, the reviewer ended, and the "holder of #2783"
 * was `worker-2783` itself, so the order was queued back to its author for ever. An author does not need to be told
 * what it wrote; another live holder, on this reference or a LATER one, still wins.
 */
function readdress(order: { session: string; prompt: string; }, agents: readonly { label: string; }[], holder: (ref: number) => { open: boolean; sessions: string[]; } | null): { to: string; ref: number; } | { author: string; ref: number; } | { none: true; looked: number[]; } |
{ unknown: string; } {
  const refs = namedRefs(order.prompt).slice(0, MAX_REFS_LOOKED_UP);
  const author = authorOf(order.prompt);
  let authorOnly: { author: string; ref: number; } | undefined;
  for (const ref of refs) {
    const facts = holder(ref);
    if (facts === null) return { unknown: `could not read who holds #${ref}` };
    const live = facts.open ? facts.sessions.filter((s) => s !== order.session && !isAbsent(s, agents)) : [];
    const to = live.find((s) => s !== author);
    if (to !== undefined) return { to, ref };
    // ONLY THE AUTHOR HOLDS THIS REFERENCE: remembered, not returned -- a later reference may have another live holder.
    if (live.length > 0 && authorOnly === undefined) authorOnly = { author: (author as string), ref };
  }
  return authorOnly ?? { none: true, looked: refs };
}

/**
 * Retire one order as DROPPED, by APPENDING that it was -- never a `delivered` line, because nothing was delivered,
 * and never a rewrite of the log (see {@link dropHandoffs}: no writer removes a line another writer wrote).
 * The record carries what a later reader needs to tell it from a delivery and to act on it: the order id, the
 * target, the age, the reason, the author when the order names one, where it went, and -- when it went nowhere --
 * THE PROMPT ITSELF, so a drop loses no text. {@link readHandoffs} folds it, so the order stops counting as waiting.
 */
export function recordDrop(path: string, order: { id: string; session: string; prompt: string; queuedAt?: number; }, { reason, reroutedTo }: { reason: string; reroutedTo?: string; }, { write = writeFileSync, now = Date.now() }: { write?: typeof writeFileSync; now?: number; } = {}) {
  const queuedAt = Number(order.queuedAt ?? now);
  const record = { dropped: order.id, session: order.session, author: authorOf(order.prompt), queuedAt,
    ageMs: Math.max(0, now - queuedAt), at: now, reason, reroutedTo: reroutedTo ?? null,
    prompt: reroutedTo === undefined ? order.prompt : null };
  write(path, `${JSON.stringify(record)}\n`, { flag: "a" });
}

export type EndedDeps = {agents: readonly {label: string}[], ended: ReadonlyMap<string, number>, holder: (ref: number) => {open: boolean, sessions: string[]} | null, queuePath: string, write?: typeof writeFileSync, now?: number};

/**
 * RESOLVE EVERY ORDER WHOSE TARGET HAS ENDED, on the first tick that sees the target gone (#2459 done-when 1c), by
 * re-addressing it to the live session that holds what it names, else dropping it with a record. Anything else is
 * left exactly as it was: a live target, an absent one, and an ended one whose holder could not be read.
 *
 * THE NEW ORDER IS WRITTEN BEFORE THE OLD ONE IS RETIRED, so a crash between the two leaves the order twice --
 * visible, and harmless to whoever reads it -- and never zero times, which is the defect this queue exists to
 * remove. The re-addressed order keeps its `queuedAt` and its `decision`: the wait is still measured from when
 * the author first asked, and an ask stays an ask.
 *
 *
 *
 * @returns the ids no longer waiting, and what to say about each order touched
 */
export function resolveEndedHandoffs(handoffs: readonly { id: string; session: string; prompt: string; queuedAt?: number; decision?: boolean; fyi?: boolean; }[], deps: EndedDeps): { settled: string[]; lines: string[]; } {
  const asked: Map<number, { open: boolean; sessions: string[]; } | null> = new Map();
  // ONE LOOKUP PER REFERENCE PER TICK: fifty orders naming one row are one question.
  const holder = (ref: number) => {
    if (!asked.has(ref)) asked.set(ref, deps.holder(ref));
    return asked.get(ref) ?? null;
  };
  const settled: string[] = [];
  const lines: string[] = [];
  for (const order of handoffs) {
    const state = targetState(order.session, deps.agents, deps.ended);
    const line = state === "ended" ? settle(order, readdress(order, deps.agents, holder), deps)
      : state === "absent" ? settleOrphan(order, holder, deps) : null;
    if (line === null) continue;
    lines.push(line.said);
    if (line.done) settled.push(order.id);
  }
  return { settled, lines };
}

/**
 * HOW LONG A QUEUED ORDER'S SESSION MAY BE UNKNOWN TO THE ORG before the order is dropped (agent-org#1416). `unknown` is what herdr reports for a
 * workspace whose pane has no agent: `worker-agent-org-1325` was written for a row that closed, its worktree went, and the order was `UNDELIVERED`
 * on 593 ticks in 26 hours with nothing to drop it. Two hours is the bound a waiting order already has ({@link HANDOFF_STALE_MS}): a session that comes
 * back inside it gets its order, and one that does not is not coming back.
 * WOULD CHANGE ON: a reading of how many `dropped` records' sessions came back inside the bound, from the `reason` each record carries. Moving it is this one line.
 */
export const UNKNOWN_SESSION_MS = HANDOFF_STALE_MS;

/** Where each waiting order's first unknown tick is kept, in milliseconds by order id, beside the queue. */
export const UNKNOWN_SINCE_FILE = "handoff-unknown-since.json";

/**
 * IS THIS ORDER'S SESSION UNKNOWN TO THE ORG RIGHT NOW: no standing seat, no reviewer instance, no pane that has an agent. An engineer instance
 * (`worker-<n>`) is unknown only when its row is CLOSED, the same reading {@link settleOrphan} takes -- an open row may yet start its instance.
 */
function sessionUnknown(session: string, deps: { agents: readonly { label: string; status: string; paneless?: boolean; }[]; roster: readonly string[]; isLead: (label: string) => boolean; holder: (ref: number) => { open: boolean; sessions: string[]; } | null; }): boolean {
  const isOrgSession = session === "engineers" || deps.roster.includes(session) || reviewerInstance(session) !== null || deps.isLead(session);
  if (isOrgSession) return false;
  const seat = deps.agents.find((a) => a.label === session);
  // agent-org#1413: A LISTED SEAT WHOSE PANE IS GONE IS NOT A SEAT THE ORG CAN DELIVER TO, WHATEVER ITS ROW SAYS: it is unknown, and its orders age out like any other's.
  if (seat?.paneless === true) return true;
  if (seat !== undefined && seat.status !== "unknown") return false;
  const row = engineerRow(session);
  if (row === null) return true;
  const facts = deps.holder(row);
  return facts !== null && !facts.open;
}

/**
 * DROP AN ORDER WHOSE SESSION THE ORG HAS NOT KNOWN FOR A BOUND (agent-org#1416). The order is retired with a record that carries its text, as
 * {@link settleOrphan} does, and the row it names is told by a comment on that row (a report needing no decision is a row write, #2167). The bound is
 * measured from the first tick that saw the session unknown, kept in {@link UNKNOWN_SINCE_FILE}, so one session that comes back is known again and its
 * clock is cleared. NEVER dropped while the account is paused: a paused seat is not unknown, it is waiting for the limit to reset.
 *
 * @returns the orders still waiting, and one line per order dropped
 */
export function dropUnknownHandoffs(handoffs: readonly { id: string; session: string; prompt: string; queuedAt?: number; }[], deps: {
  agents: readonly { label: string; status: string; paneless?: boolean; }[]; roster: readonly string[]; isLead: (label: string) => boolean;
  holder: (ref: number) => { open: boolean; sessions: string[]; } | null; post: (args: string[]) => unknown; queuePath: string; paused: boolean; now?: number;
}): { kept: typeof handoffs; lines: string[] } {
  const now = deps.now ?? Date.now();
  const statePath = join(dirname(deps.queuePath), UNKNOWN_SINCE_FILE);
  const since: Record<string, number> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const next: Record<string, number> = {};
  const dropped = new Set<string>();
  const lines: string[] = [];
  for (const order of handoffs) {
    if (deps.paused || !sessionUnknown(order.session, deps)) continue;
    const first = since[order.id] ?? now;
    if (now - first < UNKNOWN_SESSION_MS) { next[order.id] = first; continue; }
    const author = authorOf(order.prompt);
    const row = namedRefs(order.prompt)[0];
    const waited = waitedFor(now - first);
    recordDrop(deps.queuePath, order, { reason: `session "${order.session}" is unknown to the org (no pane, not a standing seat) for ${waited}` }, { now });
    dropped.add(order.id);
    lines.push(`DROPPED ${order.id}: "${order.session}" is unknown to the org (no pane, not a standing seat) and has been for ${waited}, so order `
      + `${order.id}${author === null ? "" : ` from "${author}"`}${row === undefined ? "" : ` carrying #${row}`} has no addressee. It is retired with a record `
      + "(`dropped`, carrying its text), not as a delivery.\n");
    if (row === undefined) continue;
    try {
      deps.post(["issue", "comment", String(row), "--body", `Order ${order.id} was written for "${order.session}", which the org has not known for ${waited} `
        + "(no pane, not a standing seat). It was dropped from the queue with a record and nothing was delivered. If the work still needs doing, send it to a session that exists."]);
    } catch (err) {
      lines.push(`DROP NOT TOLD ON #${row}: ${order.id} was dropped but the comment failed (${firstLine(err)}).\n`);
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(since)) writeFileSync(statePath, JSON.stringify(next));
  return { kept: handoffs.filter((h) => !dropped.has(h.id)), lines };
}

/** The row an engineer instance is named for: `worker-2783` -> 2783. Anything else is `null`. */
function engineerRow(session: string): number | null {
  const found = /^worker-([1-9][0-9]*)$/.exec(session);
  return found === null ? null : Number(found[1]);
}

/**
 * AN ORDER FOR AN ENGINEER INSTANCE THAT IS GONE AND WHOSE ROW IS CLOSED HAS NOBODY TO WAIT FOR (#2853). `absent` is
 * kept in general ({@link targetState}) because the tick has no record of an ending -- and `worker-2783` left without
 * the teardown, so it never gets one. An engineer instance is named for its row (#2469) and never started twice, so
 * once GitHub says the row is closed nothing will ever start under that name. A row that is open keeps its order (an
 * instance may yet start), and a row GitHub would not read keeps it too: dropped only on a reading that was made.
 *
 *
 * @returns `null` when the order is none of this function's business
 */
function settleOrphan(order: { id: string; session: string; prompt: string; queuedAt?: number; }, holder: (ref: number) => { open: boolean; sessions: string[]; } | null, deps: EndedDeps): { done: boolean; said: string; } | null {
  const row = engineerRow(order.session);
  if (row === null) return null;
  const facts = holder(row);
  if (facts === null || facts.open) return null;
  const now = deps.now ?? Date.now();
  const author = authorOf(order.prompt);
  recordDrop(deps.queuePath, order, { reason: `target has no workspace and its row #${row} is closed` }, { write: deps.write, now });
  return { done: true, said: `DROPPED ${order.id}: "${order.session}" has no workspace and its row #${row} is closed, so order `
    + `${order.id}${author === null ? "" : ` from "${author}"`} (waited ${waitedFor(now - Number(order.queuedAt ?? now))}) has no `
    + "addressee and never will. It is retired with a record (`dropped`, carrying its text), not as a delivery.\n" };
}

/**
 * Carry out one order's outcome, and say it. The line NAMES THE TARGET AS GONE -- never as busy -- and says what was
 * done about the order, who wrote it, and how long it waited.
 */
export function settle(order: { id: string; session: string; prompt: string; queuedAt?: number; decision?: boolean; fyi?: boolean; }, outcome: ReturnType<typeof readdress>, deps: EndedDeps): { done: boolean; said: string; } {
  const now = deps.now ?? Date.now();
  const io = { write: deps.write, now };
  const author = authorOf(order.prompt);
  const gone = `"${order.session}" has ENDED (torn down ${new Date(deps.ended.get(order.session) ?? 0).toISOString()}), `
    + `so order ${order.id}${author === null ? "" : ` from "${author}"`} (waited ${waitedFor(now - Number(order.queuedAt ?? now))}) has no addressee`;
  if ("unknown" in outcome) {
    return { done: false, said: `ENDED SESSION, ORDER KEPT ${order.id}: ${gone}; ${outcome.unknown}, so it is `
      + "neither re-addressed nor dropped and is asked again next tick.\n" };
  }
  if ("to" in outcome) {
    const entry = queueHandoff(deps.queuePath, { session: outcome.to, decision: order.decision === true, fyi: order.fyi === true,
      prompt: `${order.prompt}\n\n(Re-addressed by the tick: this was written for "${order.session}", which has ended. `
        + `You hold #${outcome.ref}, which it names.)`, now: Number(order.queuedAt ?? now), write: deps.write });
    recordDrop(deps.queuePath, order, { reason: `target ended; re-addressed to the holder of #${outcome.ref}`,
      reroutedTo: outcome.to }, io);
    return { done: true, said: `RE-ADDRESSED ${order.id}: ${gone}. #${outcome.ref} is held by live "${outcome.to}", `
      + `so it now waits there as ${entry.id}.\n` };
  }
  if ("author" in outcome) {
    recordDrop(deps.queuePath, order, { reason: `target ended; the only live holder of #${outcome.ref} is its own author "${outcome.author}"` }, io);
    return { done: true, said: `DROPPED ${order.id}: ${gone}, and the only live holder of #${outcome.ref} is "${outcome.author}", `
      + "who wrote it. An author is not told what it wrote; it is retired with a record (`dropped`, carrying its text).\n" };
  }
  const named = outcome.looked.length === 0 ? "names no row or pull request"
    : `names ${outcome.looked.map((n) => `#${n}`).join(", ")}, none open and held by a live session`;
  recordDrop(deps.queuePath, order, { reason: `target ended; the order ${named}` }, io);
  return { done: true, said: `DROPPED ${order.id}: ${gone}, and it ${named}. It is retired with a record `
    + "(`dropped`, carrying its text), not as a delivery.\n" };
}

/**
 * Who holds a row or pull request, from GitHub's REST issue read (which answers for both, and spends the CORE pool
 * rather than GRAPHQL). `null` for anything GitHub would not say; a reference that does not exist is CLOSED and
 * held by nobody, because an order mentioning `#99999` in prose must not be kept for ever by a 404.
 */
export function holderOf(ref: number, run: (args: string[]) => string = defaultGh): { open: boolean; sessions: string[]; } | null {
  try {
    const read = JSON.parse(run(["api", `repos/${REPO}/issues/${ref}`, "--jq", "{state, labels: [.labels[].name]}"]));
    const sessions = (read.labels as string[]).filter((l) => l.startsWith(SESSION_PREFIX))
      .map((l) => l.slice(SESSION_PREFIX.length)).sort();
    return { open: read.state === "open", sessions };
  } catch (err) {
    return /HTTP 404|Not Found/.test(String((err as any)?.stderr ?? (err as any)?.message))
      ? { open: false, sessions: [] } : null;
  }
}

/**
 * A queued order as `deliver` takes one -- AND THE TEXT SAYS IT WAITED.
 *
 * A reviewer woken with a prompt written 40 minutes ago must be able to tell that from a fresh one: the
 * head it names may have moved, and `update-branch` invalidates a verdict sha. Silently handing over a
 * stale order would trade one invisible failure for another.
 */
export function handoffOrder(handoff: { id: string; session: string; prompt: string; queuedAt?: number; resume?: boolean; }, now: number = Date.now()) {
  const waited = waitedFor(now - Number(handoff.queuedAt ?? now));
  return {
    session: handoff.session,
    causeKey: handoff.id,
    ...(handoff.resume === true ? { resume: true } : {}),
    prompt: `${handoff.prompt}\n\n(Queued ${waited} ago: \`prompt:session\` could not deliver `
      + "this when it was written, because you were mid-turn, so the gate held it until you were between "
      + "tasks. Re-read anything it names -- a head may have moved since.)",
  };
}

/**
 * THE KERNEL'S CEILING ON ONE ARGUMENT, and the reason a batch is bounded rather than unbounded.
 *
 * `deliver` hands the prompt to `execFileSync` as a single argv entry, and Linux caps one entry at
 * `MAX_ARG_STRLEN` -- 32 pages. MEASURED ON THIS HOST 2026-09-23 by spawning `/bin/true` with arguments
 * of increasing length: 131,071 bytes is accepted and 131,072 is `E2BIG`. The queue that produced this
 * row held 136,919 characters for one session, SO AN UNBOUNDED "ONE DELIVERY WHOSE BODY IS ALL 57
 * REPORTS" WOULD HAVE FAILED OUTRIGHT on the very backlog it was written for -- and failed as a herdr
 * refusal, which `deliver` reports and leaves queued, i.e. a stall with an error message on it.
 */
export const PROMPT_ARG_MAX = 131_072;

/**
 * How many bytes one delivery carries -- MEASURED ON WHAT REACHES `execFileSync`, not on what the
 * senders wrote.
 *
 * HALF THE MEASURED CEILING, ON PURPOSE, and the margin is not superstition: a batch of one order that
 * happens to be enormous is taken anyway (see {@link fitBatch}), so the budget has to leave the kernel's
 * ceiling somewhere above it rather than exactly at it. The ceiling also counts BYTES while a prompt
 * full of em dashes counts fewer characters than bytes, which is why `Buffer.byteLength` is the measure
 * everywhere below.
 *
 * It is also as much as a reader can use. 64 KiB is roughly 16k tokens of somebody else's reports in one
 * turn; the remainder is not lost, it is the next tick's delivery, and the backlog report says how much
 * of it there is.
 */
export const HANDOFF_BATCH_BYTES = 64 * 1024;

/**
 * The WIDEST name {@link route} could substitute into this target's batch.
 *
 * EXACT FOR A NAMED SESSION AND WORST-CASE FOR THE POOL, because those are the two things `route` can
 * do. An order addressed to `reviewer-2` renders `reviewer-2` and nothing else; an order addressed to
 * `engineers` renders whichever roster member is free at delivery time, which this cannot know and must
 * not guess low -- the batch is built before the routing decision, so the charge has to hold for every
 * label the decision could produce.
 *
 * AN EMPTY ROSTER CHARGES THE PLACEHOLDER, i.e. nothing: with no engineer to route to, `deliver` refuses
 * the batch and no argv is ever built, so there is nothing to over-charge for.
 */
export function targetLabelBytes(session: string, roster: readonly string[] = []): number {
  if (session !== "engineers") return Buffer.byteLength(session, "utf8");
  const widths = roster.map((label) => Buffer.byteLength(label, "utf8"));
  return widths.length === 0 ? YOU_PLACEHOLDER_BYTES : Math.max(...widths);
}

/**
 * ONE DELIVERY PER TARGET, whose body is every order that fits.
 *
 * 57 ORDERS FOR ONE SESSION ARE NOT 57 WAKE-UPS, AND DELIVERING THEM AS 57 IS WORSE THAN NOT DELIVERING
 * THEM. `deliver` marks a session `working` the moment it accepts a prompt, so a per-order loop reached
 * exactly ONE of them per tick and refused the other 56 -- the queue's throughput was one order every two
 * minutes against an inbox filling faster than that, which is the arithmetic behind a ten-hour wait. And
 * the throughput was the kinder half: every delivery CLEARS its target first, so a mechanism that did
 * manage to send two in a row would erase the context the first one created before the session had
 * answered it.
 *
 * SO THE BATCH IS THE UNIT, and `held` is what did not fit rather than what was dropped. Nothing leaves
 * the queue until herdr has accepted the batch carrying it ({@link deliverHandoffs}), and the ids a batch
 * covers travel with it because the drop is keyed on them.
 *
 * THE ROSTER IS HERE FOR THE BUDGET, not for the routing -- `deliver` still decides which engineer takes
 * an `engineers` batch. {@link targetLabelBytes} needs it to know how wide that name could be, because
 * the batch is built before the decision and the charge has to hold for whichever way it goes.
 */
export function handoffBatches(handoffs: readonly {
        id: string; session: string; prompt: string; queuedAt?: number;
        decision?: boolean;
    }[],
  { now = Date.now(), budget = HANDOFF_BATCH_BYTES, roster = [] }: { now?: number; budget?: number; roster?: readonly string[]; } = {}): { session: string; causeKey: string; prompt: string; ids: string[]; }[] {
  const bySession: Map<string, {
      id: string; session: string; prompt: string; queuedAt?: number;
      decision?: boolean;
  }[]> = new Map();
  for (const h of handoffs) bySession.set(h.session, [...(bySession.get(h.session) ?? []), h]);
  return [...bySession.values()].map((forSession) => {
    const { take, held } = fitBatch(forSession, budget, now,
      targetLabelBytes(forSession[0].session, roster));
    // ONE ORDER IS STILL ONE ORDER, and it keeps `handoffOrder`'s exact wording and its own id as the
    // causeKey. The common case -- an author prompting one reviewer about one draft -- must not start
    // reading like a digest of itself, and `WOKE reviewer <- handoff/reviewer/1a2b3c4d` stays the line
    // an operator can grep back to the queue.
    if (take.length === 1 && held.length === 0) {
      return { ...handoffOrder(take[0], now), ids: [take[0].id] };
    }
    return { ...batchedOrder(take, held, now), ids: take.map((h) => h.id) };
  });
}

/**
 * HOW MANY ORDER NUMBERS THE HEADER LISTS before it says "and N more". The list rides inside
 * {@link BATCH_WRAPPER_BYTES}'s reserve, which is a fixed size, so it cannot grow with the batch: a batch
 * can hold over a thousand orders, and every one of them being a declared decision must not spend the
 * reserve. Each order past the cap is still tagged `(DECISION)` at its own heading ({@link orderHeading}).
 */
export const MAX_LISTED_DECISIONS = 40;

/**
 * WHICH OF THESE ORDERS THEIR SENDERS SAID ASK FOR AN ANSWER -- the line a reader triages by (#2222).
 *
 * THE SENDER KNOWS AND NOBODY ELSE CAN COMPUTE IT. Measured on the 27-order delivery this row was filed
 * on: 22 of the 30 orders that opened as a routine report also asked for a decision, so a classifier on
 * the opening line demotes exactly the messages that need an answer. The fact is therefore DECLARED at
 * `prompt:session` and only READ here -- there is no inference in this function, and adding one would
 * rebuild the classifier the measurement rules out.
 *
 * THE NUMBERS ARE THOSE OF THE HEADINGS BELOW, oldest first, because a list a reader must translate is
 * one they will not use.
 *
 * WHEN NONE IS DECLARED IT SAYS SO AND SAYS WHAT THAT MEANS: an order with no flag is FYI, so silence
 * here is a reading of what senders DECLARED, not a finding that nothing asks. Printing nothing instead
 * would look identical to a queue whose senders had never heard of the flag. A question attached to a
 * ROW is not this line's business -- that stays on the row's `answer:` label, which is the place to look
 * for it.
 */
export function decisionHeader(take: readonly { decision?: boolean; }[]): string {
  const numbers = take.flatMap((h, i) => (declaresDecision(h) ? [i + 1] : []));
  if (numbers.length === 0) {
    return `DECISIONS DECLARED: none of these ${take.length} orders. A sender that gave no flag is counted `
      + "as FYI, so this is what was DECLARED, not proof that nothing here asks -- an ask that belongs to "
      + `a row is on that row's \`${ANSWER_PREFIX}\` label.`;
  }
  const listed = numbers.slice(0, MAX_LISTED_DECISIONS).map((n) => `ORDER ${n}`).join(", ");
  const more = numbers.length > MAX_LISTED_DECISIONS
    ? `, and ${numbers.length - MAX_LISTED_DECISIONS} more (each is tagged (DECISION) at its own heading)` : "";
  return `DECISIONS DECLARED: ${numbers.length} of ${take.length} orders ask you for an answer -- ${listed}`
    + `${more}. Read those first. The rest are FYI, or gave no flag and are counted as FYI.`;
}

/**
 * The batch body: the header that explains why it is a batch, then every order, oldest first.
 *
 * THE HEADER IS NOT DECORATION. A session handed 30 reports in one turn will otherwise read them as one
 * message from one sender, and they are 30 messages from six senders written over ten hours, several of
 * which have since been answered. Saying so is the same duty `handoffOrder` already discharges for a
 * single stale order -- *"re-read anything it names, a head may have moved"* -- at the scale that
 * actually occurred.
 */
function batchedOrder(take: readonly { session: string; prompt: string; queuedAt?: number; decision?: boolean; resume?: boolean; }[], held: readonly unknown[], now: number) {
  const oldest = waitedFor(Math.max(...take.map((h) => now - Number(h.queuedAt ?? now)), 0));
  const body = take.map((h, i) => `${orderHeading(h, i, take.length, now)}${h.prompt}`).join("\n\n");
  return {
    session: take[0].session,
    // ONE RE-SENT ORDER IN THE BATCH SPARES THE WHOLE BATCH THE CLEAR (#2470): the clear would wipe the very context the re-send exists to keep.
    ...(take.some((h) => h.resume === true) ? { resume: true } : {}),
    // NOT ANY ONE ORDER'S ID. This wake answers all of them, and naming one of them in the log would
    // read as the other N-1 having gone somewhere else.
    causeKey: `handoff/${take[0].session}/batch-of-${take.length}`,
    prompt: `${take.length} ORDERS WERE QUEUED FOR YOU AND ARRIVE TOGETHER, oldest first; the oldest has `
      + `waited ${oldest}. \`prompt:session\` could not deliver any of them when they were written, `
      + "because you were mid-turn each time, so the gate held them until you were between tasks.\n"
      + `${decisionHeader(take)}\n`
      + `THIS IS ONE WAKE CARRYING MANY REPORTS, NOT MANY WAKES: ${CONTEXT_PLACEHOLDER} Sending them one at a time `
      + "would pay that again for each (#1966, #2102, #3440).\n"
      + "They are from several senders and were written over the whole period above. RE-READ WHAT THEY "
      + "NAME BEFORE ACTING: some will already be settled, and the row, the PR and the API are the "
      + "state -- not this message."
      + (held.length > 0 ? `\n${held.length} further order(s) for you did not fit in one delivery and `
        + "are STILL QUEUED; the next tick brings them. Nothing has been dropped." : "")
      + `\n\n${body}`,
  };
}

/**
 * Deliver what is queued, drop what landed, and say which sessions are now busy.
 *
 * REUSES `deliver` WHOLE, AND `record` IS THE SEAM THAT MAKES THAT HONEST. `deliver` calls `record` only
 * after herdr has accepted the prompt -- it is the ledger hook -- so passing a collector instead of the
 * ledger writer gets exactly the ids that landed, with the report-before-record rule already applied and
 * no second copy of the route/clear/prompt loop to drift from the first.
 *
 * NO LEDGER AND NO `counts`: an authored order has no causeKey to dedupe on and no cause that can stay
 * true after it is answered, so `undelivered` and `MAX_DELIVERIES` would both be answering a question
 * nobody is asking here. See {@link handoffId}.
 *
 *
 *
 *
 * @param [deps] `goneSeats` is `deliver`'s (#3568), passed straight through; `clock` is
 *   `deliver`'s last-order record (#3440), passed straight through; `sleep` is `deliver`'s clear settle,
 *   passed straight through (#2546); `contextRoot` is `deliver`'s compact-check transcript root, the same way (#2688);
 *   `checkout` is the seam a live reviewer's re-point reads, the same way (#3031: a handoff now reaches one)
 * @returns `ids` is every
 *   order a delivery CARRIED, which is what the caller subtracts before calling anything still stale; `settled` and `goneSeats` are `deliver`'s (#3568)
 */
export function deliverHandoffs(handoffs: { id: string; session: string; prompt: string; queuedAt?: number; decision?: boolean; }[], agents: { label: string; status: string; }[], roster: string[],
  { run = defaultRun, queuePath, drop = dropHandoffs, now = Date.now(),
    budget = HANDOFF_BATCH_BYTES, unavailable, sleep, contextRoot, checkout, clock, goneSeats }: {
          run?: (args: string[]) => string; queuePath?: string; drop?: typeof dropHandoffs;
          now?: number; budget?: number; unavailable?: (label: string) => string | null;
          sleep?: (ms: number) => void; contextRoot?: string; checkout?: CheckoutDeps; clock?: OrderClock;
          goneSeats?: ReadonlyMap<string, string>;
      } = {}): { sent: string[]; refused: string[]; settled: string[]; goneSeats: Map<string, string>; ids: string[]; busied: Set<string>; } {
  const batches = handoffBatches(handoffs, { now, budget, roster });
  const landed: string[] = [];
  const { sent, refused, settled, goneSeats: gone } = deliver(batches, agents, roster,
    { run, record: (key) => landed.push(key), unavailable, sleep, contextRoot, checkout, clock, goneSeats });
  // THE BATCH IS WHAT WAS ACCEPTED; THE IDS ARE WHAT IT COVERED. `record` fires on the causeKey, because
  // that is the seam `deliver` offers, so the ids to retire come back through the batch that carried
  // them -- and a batch nobody accepted retires nothing, which is the assertion this whole queue is for.
  const done = new Set(landed);
  const delivered = batches.filter((b) => done.has(b.causeKey));
  const ids = delivered.flatMap((b) => b.ids);
  if (queuePath) drop(queuePath, ids);
  return { sent, refused, settled, goneSeats: gone, ids, busied: new Set(delivered.map((b) => b.session)) };
}

/**
 * HOW LONG A WAKE COUNTS FOR. After this, a cause still true is asked again.
 *
 * THE LEDGER RECORDED "I SENT A PROMPT", NOT "THE WORK GOT DONE", AND THAT IS WHY THE ORG KEPT GOING
 * QUIET WITH WORK IN FRONT OF IT. Every wake was one-shot and permanent: the moment an agent was prompted
 * about a row, that key was spent for ever, so an agent that then failed, stalled, ran out of context or
 * simply did not claim left the row stranded and nothing ever offered it again.
 *
 * Measured 2026-09-18: rows #1433 and #1435 Ready and unclaimed, zero open pull requests, all eight
 * sessions idle, the gate emitting both orders correctly -- and the tick exiting QUIET, because
 * `engineers/ready-row-unclaimed/1433` and `/1435` were already in the ledger from the night before.
 *
 * I built that deliberately and wrote the justification into this file -- *"a ledger keyed on anything
 * this script chose would re-wake every tick"* -- which is true, and I solved it by never re-waking at
 * all. The answer is a WINDOW, not a choice between spam and silence.
 *
 * TWENTY MINUTES, and the number comes from the org's own liveness rule rather than from taste.
 * `product-manager.md` measures a claim as live "while its branch has a push or its row has a comment
 * from the claimant in the last four hours"; four hours is the right patience for work already begun and
 * far too long for work never begun -- a row nobody claimed sits idle for that whole window with
 * engineers free. Twenty minutes is ten ticks: long enough that an agent reading a brief and claiming a
 * row is never interrupted, short enough that a wake which did not stick costs one idle engineer twenty
 * minutes rather than a night.
 *
 * HOW MUCH OF WHAT THIS WINDOW RE-HANDS IS REDUNDANT -- a READING AT A MOMENT, re-run before quoting (#2280).
 * DEFINITION: a delivery is REDUNDANT when the same causeKey (which carries the PR head, so "the same
 * subject at the same commit") was already delivered to the same addressee -- the recorded recipient for a
 * pool order, else the key's first segment. It is a DEFECT only when the earlier delivery was younger than
 * this window (or `JUDGMENT_TTL_MS` for a judgment cause); a re-ask AFTER it is this window working.
 * MEASURED 2026-09-24T11:16Z at 65eb7e978, over the whole `wake-ledger` (2026-09-18T07:23Z onward, 1,184
 * dated deliveries, across eleven addressees -- nine named in the comment, plus `worker-4` and `worker-5`,
 * one delivery each, 0 redundant, pool orders whose recorded recipient is not the key's first segment):
 * 454 redundant, of which 447 are re-asks after the window and 7 are inside it. The 7:
 * five on 2026-09-18 before `JUDGMENT_TTL_MS` shipped, two on 2026-09-19 13:24Z one second apart in
 * lockstep (two wake processes over one ledger; cause not established). None since. The 506-of-1,046
 * reported for #2280 was NOT reproduced: 422 of the first 1,046 deliveries. `wake-rehand.test.ts` pins the
 * composed path against the seven.
 */
export const WAKE_TTL_MS = 20 * 60 * 1000;
export const NO_CLEAR_FIELD = "no-clear";

/**
 * One delivery's ledger line. The recipient rides AFTER the key, and so does `no-clear` (with an empty recipient
 * field when there is none), so `ledgerKeyOf` -- which every reader goes through -- still finds the same key and the
 * dedupe is untouched.
 */
export function ledgerLine(at: number, key: string, recipient?: string, { noClear = false }: { noClear?: boolean; } = {}): string {
  const fields = noClear ? [recipient ?? "", NO_CLEAR_FIELD] : recipient ? [recipient] : [];
  return `${[at, key, ...fields].join("\t")}\n`;
}

/**
 * The causeKeys still counted as delivered, given the clock.
 *
 * A LINE IS `<epochMs>\t<causeKey>[\t<recipient>[\tno-clear]]` (see {@link ledgerKeyOf}). Lines without a tab are read as OLD -- the format before this
 * change, written by a version that recorded no time -- and they expire immediately rather than being
 * discarded or kept for ever. Discarding them would re-wake every cause the moment this ships; keeping
 * them for ever is the bug. Expiring them is the honest reading: a wake whose age cannot be known has no
 * claim on the present.
 *
 * A missing file is an empty ledger; an unreadable one is NOT.
 *
 * WHAT THE LEDGER DELIBERATELY DOES NOT RECORD IS OUTCOME. Every `causeKey` is derived by `work-gate`
 * from GitHub state alone, so "did the work get done" is already answered by GitHub: an engineer who
 * claims a row gives it `in-progress`, the row leaves the unclaimed set, and the cause is never emitted
 * again whatever this file believes. A status column here would be a SECOND COPY of that answer, and the
 * two would disagree the first time a claim was made outside a wake. The ledger answers one question --
 * *did I just ask?* -- which is a question about time.
 *
 * IT DOES COUNT REPEATS, because a cause that keeps coming back is not a timing problem. A row offered
 * ten times and never claimed says something is wrong with the row, the prompt, or the engineer, and
 * retrying it silently for ever is the same defect as never retrying at all, only noisier.
 */
export function readLedger(path: string, read: (p: any, enc: any) => any = readFileSync, now: number = Date.now(), judgment = new Set()): Set<string> {
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return new Set();
    throw err;
  }
  const times = deliveryTimes(raw);
  const live = new Set<string>();
  for (const [key, list] of times) {
    // A JUDGMENT CAUSE GETS A LONGER WINDOW, NOT AN INFINITE ONE. Its answer is durable -- the
    // causeKey carries the state, so re-asking inside the window buys a model turn to reach a
    // conclusion somebody already reached; `orchestrator` spent one establishing that #1564 is a
    // research row waiting on a ceo ruling. But "durable" is not "eternal": shipped as NEVER EXPIRES,
    // this silenced `ready-queue-empty` for four hours with six agents idle and an empty shelf. See
    // `JUDGMENT_TTL_MS` for that measurement and for why two hours is the number.
    const cause = key.split("/")[1] ?? "";
    const ttl = judgment.has(cause) ? JUDGMENT_TTL_MS : WAKE_TTL_MS;
    if (list.length > 0 && now - Math.max(...list) < ttl) live.add(key);
  }
  return live;
}

/**
 * Every counted delivery's time, per key, from the ledger's text: a line without a tab is OLD (unknown age, so not live), a malformed one
 * reads the same, and a VOIDED line takes one delivery back (#2470).
 */
function deliveryTimes(raw: string): Map<string, number[]> {
  const times: Map<string, number[]> = new Map();
  for (const line of raw.split("\n")) {
    const text = line.trim();
    const tab = text.indexOf("\t");
    if (!text || tab < 0) continue;
    const at = Number(text.slice(0, tab));
    const key = ledgerKeyOf(text.slice(tab + 1));
    if (!Number.isFinite(at) || !key) continue;
    if (key.startsWith(`${VOIDED}\t`)) takeBackDelivery(times, key.slice(VOIDED.length + 1), Number(text.split("\t")[3]));
    else times.set(key, [...(times.get(key) ?? []), at]);
  }
  return times;
}

/**
 * A VOIDED LINE TAKES BACK ONE DELIVERY (#2470, done-when 11d): the one at `deliveredAt`, or the newest when that time is not on the
 * ledger. A delivery a restart killed never reached its target, so it must not keep the cause live for the window (the gate's order would
 * then be dropped as "already delivered", silently, for twenty minutes or two hours) and must not spend `MAX_DELIVERIES`.
 */
function takeBackDelivery(times: Map<string, number[]>, key: string, deliveredAt: number) {
  const list = times.get(key);
  if (list === undefined || list.length === 0) return;
  const at = list.lastIndexOf(deliveredAt);
  list.splice(at === -1 ? list.length - 1 : at, 1);
}

/** The one engineer brief, from the repository root: general lessons, the acceptance standard, the resource ban. */
export const ENGINEER_BRIEF = roleBriefPath("engineer.md").relative;

/**
 * The causeKeys already escalated IN THEIR CURRENT RUN, and so not to be labelled again (#2462).
 *
 * Removing the escalation label is the act of clearing (`escalateStuck`), and the gate read it as nothing: the count
 * that tripped the breaker is still at the cap and the cause is still emitted, so the next tick labelled the row
 * again. Measured 2026-09-25: #2451, #2258 and #2223 were re-labelled 28 s, 27 s and 26 s after a person removed
 * the label. The state after removal is exactly the state before it, so the only thing that can tell the two
 * apart is a record that the first escalation happened.
 *
 * A RUN ENDS THE MARK. A `RESET` (`endedRuns`: the cause stopped being emitted) removes it, and so does any
 * ordinary delivery line after it -- a key at the cap is not delivered, so a delivery means the run began again.
 * A CHANGED causeKey is a different key and was never marked, which is the whole "until the cause changes" of it.
 */
export function escalatedKeys(path: string, read: (p: any, enc: any) => any = readFileSync): Set<string> {
  const escalated: Set<string> = new Set();
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return escalated;
    throw err;
  }
  for (const line of raw.split("\n")) {
    const tab = line.trim().indexOf("\t");
    if (tab < 0) continue;
    const key = ledgerKeyOf(line.trim().slice(tab + 1));
    if (key.startsWith(`${ESCALATED}\t`)) escalated.add(key.slice(ESCALATED.length + 1));
    else if (key.startsWith(`${RESET}\t`)) escalated.delete(key.slice(RESET.length + 1));
    else escalated.delete(key);
  }
  return escalated;
}

/**
 * The causeKeys whose RUN OF DELIVERIES HAS ENDED -- emitted on the previous tick, absent from this one.
 *
 * THE LEDGER RECORDS DELIVERIES, NOT EMISSIONS, AND THAT IS THE WHOLE DEFECT. `MAX_DELIVERIES` exists to
 * stop a cause that keeps coming back and going nowhere, and it counted every delivery a key ever had.
 * Measured 2026-09-18: `ceo/ready-row-unclaimed/1452` spent all six of its deliveries in the morning
 * while B4 genuinely blocked the row behind an open PR. That PR merged, the row became claimable, and
 * the cap kept it silent for NINE HOURS -- the queue's only actionable job, and nothing could offer it.
 *
 * A TIME WINDOW CANNOT FIX THIS, and that was the first thing tried. Those six deliveries span 2h10m,
 * because each one has to wait out the 20-minute liveness TTL; any window long enough for the cap to
 * trigger at all still contains them. The signal is not "how long ago" but "did the cause STOP being
 * true and start again" -- and a gap in DELIVERY looks identical to a gap in EMISSION from the ledger
 * alone. So the emitted set is written down each tick, and the difference is what ends a run.
 *
 * @param emitted this tick's causeKeys
 * @param path where the previous tick's set is remembered
 *
 * @returns the keys to mark RESET, in the order they were last seen
 */
export function endedRuns(emitted: string[], path: string, { read = readFileSync, write = writeFileSync }: { read?: typeof readFileSync; write?: typeof writeFileSync; } = {}): string[] {
  let previous: string[] = [];
  try {
    previous = String(read(path, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") throw err;
  }
  const now = new Set(emitted);
  mkdirSync(dirname(path), { recursive: true });
  write(path, `${emitted.join("\n")}\n`);
  return previous.filter((key) => !now.has(key));
}

/** `<causeKey>: "<seat>" is working`, which is `route`'s own refusal for a seat mid-turn, with `routeWithFallback`'s second half when the order had one, and {@link relaneTarget}'s when it was over the bound and nobody was free. */
export const BUSY_SEAT_REFUSAL = /^(\S+): ("[^"]+" is working(?:; and the fallback "[^"]+": "[^"]+" is working)?(?:; not re-laned: [^;]+)?)$/;

/**
 * HOW LONG A READY ROW MAY WAIT FOR A FREE ENGINEER SEAT BEFORE IT IS "NOWHERE TO GO" AFTER ALL (a11ign/a11ign#3266): HALF AN HOUR.
 *
 * MEASURED 2026-10-03 from `journalctl --user -u a11ign-work-tick` over 2026-10-01T00:00+01:00 to 2026-10-03T15:30+01:00 (947 `ready-row-unclaimed`
 * lines): every run of consecutive ticks refusing one row's offer in the capacity shape ({@link CAPACITY_REFUSAL}; a gap over 10 minutes ends a run),
 * kept only if `WOKE <seat> <- engineers/ready-row-unclaimed/<row>` followed within 6 minutes, i.e. the wait ENDED in a claim. Of 67 such runs:
 * p50 0 min, p90 7, p99 13, MAX 13 (`#3256`). A tick is 2 minutes, so each is good to +-2. Half an hour is the first round number above that
 * maximum with a margin of more than twice: a ready row nobody could take for longer IS "no session is taking this work", and the answer then is
 * more seats, which is `ceo`'s call and is reported there. SIZED SEPARATELY FROM {@link BUSY_SEAT_DEFERRAL_MS}: that is a seat mid-turn (50 min).
 */
export const CAPACITY_WAIT_LIMIT_MS = 30 * 60 * 1000;

/** One seat as `route` writes it into a refusal when nothing is wrong with it but its load: `working`, a spare that holds or has held its one row ({@link spentSeen}), or one that waits for its own ({@link spareForOtherRow}). */
const LOADED_SEAT = String.raw`[\w.-]+=(?:working|has held #\d+(?:, #\d+)*: one instance, one row \(#2407\)|is for \S+ only: one instance, one row \(#2407\))`;

/**
 * What {@link routeWithFallback} puts BEFORE the pool's refusal when the order's own session is gone and it fell back to `engineers` (a11ign/a11ign#3814): a `trunk-red`
 * order for a merged PR whose author has ended waited as a fault from its first tick, 30 ticks running, on a pool that was merely full. ONLY AN ABSENT AUTHOR AND ONLY
 * THE `engineers` POOL: a first half that says the author is `working` is {@link BUSY_SEAT_REFUSAL}'s, and a fallback to any other seat is not a pool that frees itself.
 */
const GONE_AUTHOR_PREFIX = String.raw`(?:no workspace labelled "[^"]+"; and the fallback "engineers": )?`;

/**
 * `<causeKey>: [<GONE_AUTHOR_PREFIX>]no engineer is idle ... (<every seat LOADED>)`, which is `route`'s refusal for an engineer order when the roster is simply full, with
 * `targetFor`'s second half when this tick had already spent its one spawn. ANCHORED AT BOTH ENDS and demanding at least one seat, every one of them
 * loaded: an idle, drained, skipped-for-B2, `unknown`, `absent` or `blocked` seat is not capacity, and a `; no spawn: ...` tail is a failed claim, a
 * B4 overlap or a refused prompt, each a fault with a cause of its own that this must not hide.
 */
export const CAPACITY_REFUSAL = new RegExp(String.raw`^(\S+): (${GONE_AUTHOR_PREFIX}no engineer is idle(?: and allowed to claim)? \(${LOADED_SEAT}(?:, ${LOADED_SEAT})*\)`
  + String.raw`(?:, and this tick has already started \d+ \(MAX_SPAWNS_PER_TICK is \d+\))?)$`);

/**
 * #4524: THE PHRASE THAT MAKES A B4 OVERLAP A WAIT. {@link spawnClaimability} writes it into the reason of a chairman row whose overlapping pull request is
 * in the merge queue, and {@link MERGE_QUEUE_WAIT_REFUSAL} reads it back, so the producer and the classifier share one string and cannot drift apart.
 */
export const MERGE_QUEUE_WAIT_PHRASE = "which is in the merge queue";

/**
 * The ledger of ended cycles, oldest first. A LINE THAT CANNOT BE PARSED IS A FAILED CYCLE, never a skipped
 * one: this file is what a retirement is argued from, and a corrupt line that vanished from the count would
 * let a run of clean ones bridge a failure nobody could read.
 */
export function readSpareCycles(path: string, read: typeof readFileSync = readFileSync): SpareCycle[] {
  let text;
  try {
    text = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    try {
      return (JSON.parse(line) as SpareCycle);
    } catch {
      // `rows: []` so it is a line that HAS an account -- and a failed one -- rather than a legacy line (#2407).
      return { role: "?", row: null, at: 0, clean: false, rows: [], why: `unreadable ledger line: ${line.slice(0, 60)}` };
    }
  });
}

/** Where the instance registry and the cycle ledger live: beside the delivery ledger, with the org's other state. */
export function sparePathsFrom(ledgerPath: string) {
  return { registry: `${dirname(ledgerPath)}/spare-instances.json`, cycles: `${dirname(ledgerPath)}/spare-cycles` };
}
