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
import { toolPinOf } from "../pool-pin.ts";
import { log, messageOf, update } from "../pool-state.ts";
import type { PoolContext } from "../pool-context.ts";
import { dismiss, enqueue, find, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import type { Ticket } from "../source.ts";
import { isInstalled, mergesIn } from "../after-merge/installed.ts";
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

/** The file with every ticket on the queue labelled `board-reliability` watched, and the tickets the epic closed before there was a watch held to the figures {@link BACKFILLED} names. */
function enrolled(file: WatchesFile, queue: Queue): WatchesFile {
  const watches: Record<string, Watch> = { ...file.watches };
  for (const { ticket } of queue.entries) {
    if (isReliability(ticket)) watches[ticket.key] = withTicketsFigure(file.watches[ticket.key], ticket);
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
    return new Map([...await ctx.source.stateTypes(keys)].map(([key, type]) => [key, type === "completed"]));
  } catch (err) {
    log(`the reliability watches could not read their tickets' states: ${messageOf(err)}`);
    return null;
  }
}

/** The facts of one sweep for `watch`: the clock, whether its ticket is completed and its fix installed, and the figure it names as `/api/health` serves it now. */
function factsOf(ctx: PoolContext, watch: Watch, completed: ReadonlyMap<string, boolean> | null): Facts {
  const now = ctx.now();
  const figures = ctx.deps.healthFigures?.() ?? null;
  const value = watch.spec === null || figures === null ? null : readFigure(watch.spec.figure, figures);
  const installed = watch.origin === "backfill" || isInstalled({ toolRoot: toolPinOf(ctx).toolRoot, now: ctx.now, merges: (key) => mergesIn(ctx.store.get().runLog?.[key]) }, watch.key);
  return { now, completed: completed?.get(watch.key) ?? null, installed, read: figures === null || value === null ? null : { value, readings: readingsOf(figures, now) } };
}

/** Move a breached ticket out of its completed state. True when it was moved, which is read back from the tracker; false, with the reason said, when it was not. */
async function moveOut(ctx: PoolContext, watch: Watch): Promise<boolean> {
  const { source, settings } = ctx;
  const refuse = (why: string): false => { sayOnce(watch.key, `${watch.key}: its figure breached and the board could not reopen it: ${why}`); return false; };
  if (source.restoreState === undefined) return refuse("this tracker cannot move a ticket out of its completed state");
  const ticket = await source.read(watch.key);
  if (ticket === null) return refuse("the tracker has no such ticket");
  const note = await source.restoreState(watch.key, { from: settings.workingState ?? REOPEN_STATE, to: ticket.status });
  const after = await source.read(watch.key);
  return after !== null && after.status !== ticket.status ? true : refuse(note ?? `it is still ${ticket.status}`);
}

/** Queue a reopened ticket on the saved default model and effort. A ticket already queued is left; a finished run of it is cleared first. True when the ticket is on the queue afterwards. */
async function queueReopened(ctx: PoolContext, watch: Watch): Promise<boolean> {
  const refuse = (why: string): false => { sayOnce(watch.key, `${watch.key}: the board could not queue the reopened ticket: ${why}`); return false; };
  const choice = ctx.deps.runChoice?.();
  if (choice === undefined) return refuse("it has no saved model to queue it on");
  const ticket = await ctx.source.read(watch.key);
  if (ticket === null) return refuse("the tracker has no such ticket");
  update(ctx, (queue) => enqueue(dismiss(queue, ticket.key, ctx.now()), [ticket], choice, ctx.now()));
  const entry = find(ctx.store.get(), ticket.key);
  return entry !== undefined && entry.phase !== "finished" ? true : refuse("a finished run of it is still on the queue");
}

/** Post the comment with the readings; a tracker that cannot comment keeps it off the ticket, and the log says so once. */
async function postReadings({ source }: PoolContext, watch: Watch): Promise<boolean> {
  if (source.comment === undefined) sayOnce(watch.key, `${watch.key}: this tracker cannot post the readings of its reopen as a comment`);
  else await source.comment(watch.key, reopenComment(watch));
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

/** The pools whose sweep is under way: two refreshes that overlap must not both reopen a ticket. */
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
    const enrolment = changeWatches(path, (file) => enrolled(file, ctx.store.get()));
    const completed = await completedAmong(ctx, Object.keys(enrolment.watches));
    changeWatches(path, (file) => {
      const watches = Object.fromEntries(Object.entries(file.watches).map(([key, watch]) => [key, advance(watch, factsOf(ctx, watch, completed))]));
      return JSON.stringify(watches) === JSON.stringify(file.watches) ? file : { watches };
    });
    await reopenOwed(ctx, path);
  } catch (err) {
    log(`the reliability watches in ${path} could not be swept: ${messageOf(err)}`);
  } finally {
    sweeping.delete(ctx);
  }
}
