// @ts-check
// module: the reliability sweep (A11-366) -- enrol the board-reliability tickets, read each one's figure after its fix is released, and reopen the ticket once, with the readings, when the figure does not hold
//
// FIXES CLOSED ON GREEN TESTS, AND NOTHING WATCHED WHETHER THE SYMPTOM WENT AWAY. A11-282 and A11-345 were Done on 2026-10-27 while 755 synchronous holds in ten minutes and repeated `ECONNRESET` were in the board's log. Each
// tracker refresh now looks at the tickets labelled `board-reliability` (`syncReliabilityWatches`, beside the After-merge checks' sweep): the pure rules of what a watch does are `watch.ts`, and this file reads what they need
// and does what they ask.
//
// THE REOPEN IS THE BOARD'S, AND IT IS DONE ONCE. The breach is written to the file first, with the readings. The ticket is then moved out of its completed state (`restoreState`, which moves only a ticket still in the
// state it names, so a person's move is never undone), commented with the readings, and queued on the saved default model and effort. Each step is recorded when it is done, so one that failed is tried again at the next
// refresh and none is done twice. A ticket reopened and closed again is watched again from that close.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withinTime } from "../../install/time-limit.ts";
import { toolPinOf } from "../pool-pin.ts";
import { log, messageOf, update } from "../pool-state.ts";
import type { PoolContext } from "../pool-context.ts";
import { dismiss, enqueue, find, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import type { Ticket } from "../source.ts";
import { isInstalled, mergesIn, type Merge } from "../after-merge/installed.ts";
import { BACKFILLED, figureOfDescription, readFigure, RELIABILITY_LABEL } from "./figures.ts";
import { reopenComment, readingsOf } from "./text.ts";
import { changeWatches, loadWatches, reliabilityWatchesPath, type WatchesFile } from "./store.ts";
import { advance, newWatch, owesReopen, reopened, reopenStepDone, type Facts, type Watch } from "./watch.ts";

/** The state a reopened ticket is put in when the board's settings name no working state: the one a team starts its work in. */
const REOPEN_STATE = "Todo";

/** What the sweep has said already, so a refusal that holds for ever is said once: by ticket and step. */
const said = new Set<string>();
const sayOnce = (key: string, line: string): void => {
  if (said.has(`${key} ${line}`)) return;
  said.add(`${key} ${line}`);
  log(line);
};

/** `ask`, given the time the board's other tracker reads are (`ctx.readMs`, A11-359): a call that never answers is a failure of the step, not a sweep that never ends. */
const within = <T>(ctx: PoolContext, what: string, ask: Promise<T>): Promise<T> => withinTime(ctx.readMs, `the tracker's ${what}`, ask);

const isReliability = (ticket: Pick<Ticket, "labels">): boolean => (ticket.labels ?? []).some(({ name }) => name.toLowerCase() === RELIABILITY_LABEL);

/** The watch of a ticket as its description now names its figure: a spec, or the reason it has none. */
function withTicketsFigure(watch: Watch | undefined, ticket: Ticket): Watch {
  const parsed = figureOfDescription(ticket.description);
  const spec = parsed.kind === "figure" ? parsed.spec : null;
  const why = parsed.kind === "refused" ? parsed.why : parsed.kind === "none" ? "its Done-when has no `Figure:` line" : undefined;
  if (watch === undefined) return newWatch({ key: ticket.key, title: ticket.title, url: ticket.url, origin: "ticket" }, spec, why);
  if (watch.origin === "backfill" || watch.state === "held") return watch;
  const { why: _was, ...rest } = watch;
  return { ...rest, title: ticket.title, spec, ...(why === undefined ? {} : { why }) };
}

/** How long a held watch is kept after its last reading: it is then dropped, and a ticket closed again is enrolled afresh. */
const HELD_KEPT_MS = 30 * 24 * 60 * 60_000;

/** The file with every ticket on the queue labelled `board-reliability` watched, and the tickets the epic closed before there was a watch held to the figures {@link BACKFILLED} names. */
function enrolled(file: WatchesFile, queue: Queue, now: number): WatchesFile {
  const watches: Record<string, Watch> = Object.fromEntries(Object.entries(file.watches).filter(([, watch]) => watch.state !== "held" || now - (watch.last?.at ?? now) < HELD_KEPT_MS));
  for (const { ticket } of queue.entries) {
    if (isReliability(ticket)) watches[ticket.key] = withTicketsFigure(watches[ticket.key], ticket);
  }
  for (const [key, spec] of Object.entries(BACKFILLED)) {
    const entry = queue.entries.find(({ ticket }) => ticket.key === key)?.ticket;
    watches[key] ??= newWatch({ key, title: entry?.title ?? key, url: entry?.url ?? null, origin: "backfill" }, spec);
  }
  return JSON.stringify(watches) === JSON.stringify(file.watches) ? file : { watches };
}

/** Which of `keys` the tracker has completed, or null when it could not say (a tracker without `stateTypes`, or one that failed). */
async function completedAmong(ctx: PoolContext, keys: readonly string[]): Promise<ReadonlyMap<string, boolean> | null> {
  if (keys.length === 0) return new Map();
  if (ctx.source.stateTypes === undefined) return null;
  try {
    return new Map([...await within(ctx, "read of the states of the reliability tickets", ctx.source.stateTypes(keys))].map(([key, type]) => [key, type === "completed"]));
  } catch (err) {
    sayOnce("states", `the reliability watches could not read their tickets' states: ${messageOf(err)}`);
    return null;
  }
}

/** The release the tool folder holds: its `package.json` version, or null when there is no folder or it names none. */
function releaseOf(toolRoot: string | undefined): string | null {
  if (toolRoot === undefined) return null;
  try {
    const { version } = JSON.parse(readFileSync(join(toolRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** The merges of `watch`'s ticket that count for its window: after the board's last reopen, only the fixes merged since. */
function fixMerges(ctx: PoolContext, watch: Watch): readonly Merge[] {
  const merges = mergesIn(ctx.store.get().runLog?.[watch.key]);
  return watch.reopenedAt === undefined ? merges : merges.filter(({ at }) => at > watch.reopenedAt!);
}

/** `watch` with the release this host runs noted, the first sweep that sees a fix merged after its reopen. */
function notingFixRelease(ctx: PoolContext, watch: Watch): Watch {
  if (watch.reopenedAt === undefined || watch.releaseAtFix !== undefined || fixMerges(ctx, watch).length === 0) return watch;
  return { ...watch, releaseAtFix: releaseOf(toolPinOf(ctx).toolRoot) };
}

/**
 * Whether `watch`'s fix is on this host. A ticket the board reopened counts only the fixes merged since, and those only once a release other than the one it ran when it first saw them is installed: the
 * first fix's acceptance file is still in the tool folder, so `isInstalled` alone would begin the window before the second fix is released (A11-366 review).
 */
function fixInstalled(ctx: PoolContext, watch: Watch): boolean {
  if (watch.origin === "backfill") return true;
  const toolRoot = toolPinOf(ctx).toolRoot;
  const merges = fixMerges(ctx, watch);
  if (watch.reopenedAt === undefined) return isInstalled({ toolRoot, now: ctx.now, merges: () => merges }, watch.key);
  if (merges.length === 0 || watch.releaseAtFix === undefined) return false;
  const released = watch.releaseAtFix === null || releaseOf(toolRoot) !== watch.releaseAtFix;
  return released && isInstalled({ toolRoot, now: ctx.now, merges: () => merges }, watch.key);
}

/** The facts of one sweep for `watch`: the clock, whether its ticket is completed and its fix installed, and the figure it names as `/api/health` serves it now. */
function factsOf(ctx: PoolContext, watch: Watch, completed: ReadonlyMap<string, boolean> | null): Facts {
  const now = ctx.now();
  const figures = ctx.deps.healthFigures?.() ?? null;
  const value = watch.spec === null || figures === null ? null : readFigure(watch.spec.figure, figures);
  const installed = fixInstalled(ctx, watch);
  return { now, completed: completed?.get(watch.key) ?? null, installed, read: figures === null || value === null ? null : { value, readings: readingsOf(figures, now) } };
}

/** Move a breached ticket out of its completed state. True when it was moved, which is read back from the tracker; false, with the reason said, when it was not. */
async function moveOut(ctx: PoolContext, watch: Watch): Promise<boolean> {
  const { source, settings } = ctx;
  const refuse = (why: string): false => { sayOnce(watch.key, `${watch.key}: its figure breached and the board could not reopen it: ${why}`); return false; };
  if (source.restoreState === undefined) return refuse("this tracker cannot move a ticket out of its completed state");
  const ticket = await within(ctx, `read of ${watch.key}`, source.read(watch.key));
  if (ticket === null) return refuse("the tracker has no such ticket");
  const note = await within(ctx, `move of ${watch.key}`, source.restoreState(watch.key, { from: settings.workingState ?? REOPEN_STATE, to: ticket.status }));
  const after = await within(ctx, `read of ${watch.key}`, source.read(watch.key));
  return after !== null && after.status !== ticket.status ? true : refuse(note ?? `it is still ${ticket.status}`);
}

/** Queue a reopened ticket on the saved default model and effort. A ticket already queued is left; a finished run of it is cleared first. True when the ticket is on the queue afterwards. */
async function queueReopened(ctx: PoolContext, watch: Watch): Promise<boolean> {
  const refuse = (why: string): false => { sayOnce(watch.key, `${watch.key}: the board could not queue the reopened ticket: ${why}`); return false; };
  const choice = ctx.deps.runChoice?.();
  if (choice === undefined) return refuse("it has no saved model to queue it on");
  const ticket = await within(ctx, `read of ${watch.key}`, ctx.source.read(watch.key));
  if (ticket === null) return refuse("the tracker has no such ticket");
  update(ctx, (queue) => enqueue(dismiss(queue, ticket.key, ctx.now()), [ticket], choice, ctx.now()));
  const entry = find(ctx.store.get(), ticket.key);
  return entry !== undefined && entry.phase !== "finished" ? true : refuse("a finished run of it is still on the queue");
}

/** Post the comment with the readings. A tracker that cannot comment has not posted them, so the step stays owed (the watch never reads "readings posted"), and the log says so once. */
async function postReadings(ctx: PoolContext, watch: Watch): Promise<boolean> {
  if (ctx.source.comment === undefined) {
    sayOnce(watch.key, `${watch.key}: this tracker cannot post the readings of its reopen as a comment, so the reopen stays owed its readings`);
    return false;
  }
  await within(ctx, `comment on ${watch.key}`, ctx.source.comment(watch.key, reopenComment(watch)));
  return true;
}

/** One step of a reopen: what it is called in the log, the work (true when it is done), and how the watch records it. */
type Step = Readonly<{ name: string; owed: (watch: Watch) => boolean; run: (watch: Watch) => Promise<boolean>; record: (watch: Watch) => Watch }>;

/** The steps of a reopen, in order: move the ticket, post the readings on it, queue it. Each is owed until its watch records it. */
const stepsOf = (ctx: PoolContext): readonly Step[] => [
  { name: "reopen the ticket", owed: ({ state }) => state === "breached", run: (watch) => moveOut(ctx, watch), record: (watch) => reopened(watch, ctx.now()) },
  { name: "post the readings", owed: ({ state, commented }) => state === "reopened" && commented !== true, run: (watch) => postReadings(ctx, watch), record: (watch) => reopenStepDone(watch, "commented") },
  { name: "queue the ticket", owed: ({ state, queued }) => state === "reopened" && queued !== true, run: (watch) => queueReopened(ctx, watch), record: (watch) => reopenStepDone(watch, "queued") },
];

/** Do `step` for `key` if it is owed, recording it when it is done. A step that failed is logged and tried again at the next refresh. */
async function doStep(ctx: PoolContext, path: string, key: string, step: Step): Promise<void> {
  const watch = loadWatches(path).watches[key];
  if (watch === undefined || !step.owed(watch)) return;
  try {
    if (await step.run(watch)) changeWatches(path, (file) => ({ watches: { ...file.watches, [key]: step.record(file.watches[key] ?? watch) } }));
  } catch (err) {
    log(`${key}: the board could not ${step.name}, and tries again at the next refresh: ${messageOf(err)}`);
  }
}

/** Finish the reopen each watch of `path` owes. */
async function reopenOwed(ctx: PoolContext, path: string): Promise<void> {
  for (const { key } of Object.values(loadWatches(path).watches).filter(owesReopen)) {
    for (const step of stepsOf(ctx)) await doStep(ctx, path, key, step);
  }
}

/** The pools whose sweep is under way: two refreshes that overlap must not both reopen a ticket. Every tracker call of a sweep is bounded by `readMs`, so a sweep ends. */
const sweeping = new WeakSet<PoolContext>();

/**
 * One sweep, run at the end of each tracker refresh: the tickets labelled `board-reliability` on the queue, and A11-282 and A11-345, are watched; each watch is advanced by what the tracker says of its ticket, whether
 * its fix is installed and the figure `/api/health` serves; and a ticket whose figure breached is reopened once, with the readings, and queued. A file that cannot be read changes nothing, and is logged.
 */
export async function syncReliabilityWatches(ctx: PoolContext): Promise<void> {
  // A pool given no source of the figures reads none, and so watches nothing.
  if (ctx.deps.healthFigures === undefined || sweeping.has(ctx)) return;
  sweeping.add(ctx);
  const path = reliabilityWatchesPath(ctx.settings.stateDir);
  try {
    const enrolment = changeWatches(path, (file) => enrolled(file, ctx.store.get(), ctx.now()));
    const completed = await completedAmong(ctx, Object.values(enrolment.watches).filter(({ state }) => state !== "held").map(({ key }) => key));
    changeWatches(path, (file) => {
      const watches = Object.fromEntries(Object.entries(file.watches).map(([key, was]) => {
        const watch = notingFixRelease(ctx, was);
        return [key, advance(watch, factsOf(ctx, watch, completed))];
      }));
      return JSON.stringify(watches) === JSON.stringify(file.watches) ? file : { watches };
    });
    await reopenOwed(ctx, path);
  } catch (err) {
    log(`the reliability watches in ${path} could not be swept: ${messageOf(err)}`);
  } finally {
    sweeping.delete(ctx);
  }
}
