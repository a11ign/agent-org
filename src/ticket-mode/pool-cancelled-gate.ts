// @ts-check
// module: the cancelled run of a required check that blocks an approved, armed pull request (A11-342, A11-403) -- the board reruns it on a quiet head, up to a bound, and says when it stops
//
// ONE PUSH CAN START TWO `ci` RUNS FOR ONE HEAD, AND A CONCURRENCY GROUP CANCELS ONE OF THEM. a11ign/announcement-emulator#32 at `8b3d0ba9`, 2026-10-27: a push and the edit of the pull request's body (both `pull_request` events that `ci.yml` listens to)
// started runs 40438392487 and 40438392613 at 02:26:05, the group cancelled the second, and the cancelled `gate` held the merge although the first run's `gate` was green. The pull request was approved at 07:53 and armed, GitHub kept
// `mergeStateStatus` at BLOCKED and never queued it, and the board showed it as approved and armed with nothing to act on, until a session reran the cancelled run by hand and the pull request went CLEAN within a minute.
//
// THE BOARD RERUNS THAT RUN, ONE RUN AT A TIME, AND ONLY ON A QUIET HEAD. A pull request is the case when it is open, approved at its head, armed, BLOCKED, and the only non-green runs of its required checks there are cancelled ones
// (`PullFeedback.cancelledRequired`). A RERUN JOINS THE WORKFLOW'S CONCURRENCY GROUP AND CANCELS A SIBLING RUN THAT IS STILL RUNNING (a11ign/agent-org#2017, A11-403: the rerun of `ci` run 41399910129 cancelled the healthy 41399933489, and the board, which reran only once,
// left the pull request BLOCKED), so before it reruns the board asks the code host whether any run of that workflow at the head has not completed (`runsInProgress`, contract 4.1) and waits for the next watch if one has. The check rollup cannot answer it:
// a `gate` that `needs` other jobs has no check run until they finish. The code host reruns the first cancelled run whole (`rerunRuns`, `gh run rerun <id>`), no worker is asked, and the run's log records it (`cancelled-rerun`).
//
// THE BOUND IS THE LOG, which outlives a restart of the board: a head may have {@link MAX_CANCELLED_RUNS} cancelled runs, so two accepted reruns. When the third is read, the board writes one `cancelled-rerun` event with `stopped`, says so in its own log, and the card
// says it (`Entry.cancelledRerunStopped`) until the head moves or the cancelled runs go. A rerun the host REFUSES is logged with its reason and asked again at the next watch, up to {@link MAX_REFUSALS} times for a head, so a refusal that cannot change does not become
// a call at every watch for ever. A pull request that is not approved, not armed, not blocked, or blocked on anything else is left alone.
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import { reviewAtHead } from "./pool-settle.ts";
import type { PoolContext } from "./pool-context.ts";
import { log, update } from "./pool-state.ts";
import { replace, type Entry, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { logEvent, logOf, shortReason, type RunEvent } from "./queue/run-log.ts";
import { type CancelledRerun, type CancelledStop, MAX_CANCELLED_RUNS, cancelledRerunWords } from "./board-view/cancelled-rerun-words.ts";

export { MAX_CANCELLED_RUNS };

/** How many refused reruns the board puts up with for one head before it stops asking. */
export const MAX_REFUSALS = 3;

/** How many reruns the code host may take for one head: the first run is cancelled once before any rerun, so {@link MAX_CANCELLED_RUNS} cancelled runs are the first and two reruns. */
const MAX_RERUNS = MAX_CANCELLED_RUNS - 1;

/** An open pull request and what the board read of it. */
type OpenPull = Readonly<{ url: string; read: PullFeedback }>;

/** A `cancelled-rerun` event of the log. */
type RerunEvent = Extract<RunEvent, { kind: "cancelled-rerun" }>;

/** Whether the pull request is open at a head, approved there, armed and BLOCKED: the state the cancelled run holds it in. PURE. */
const isBlockedAndArmed = (read: PullFeedback): boolean => read.state === "open" && read.head !== null && reviewAtHead(read) === "approved" && read.armed === true && read.blocked === true;

/** The addresses of the cancelled runs that block `read`, or none when it is not the case: not open, no head, not approved there, not armed, not BLOCKED, or blocked on something other than cancelled runs. PURE. */
export function cancelledGateRuns(read: PullFeedback): readonly string[] {
  if (!isBlockedAndArmed(read)) return [];
  return (read.cancelledRequired ?? []).flatMap(({ detailsUrl }) => (detailsUrl === null ? [] : [detailsUrl]));
}

/** What the run's log records of the board's reruns for one pull request at one head, sorted by what the board made of them. */
type Tries = Readonly<{ taken: number; refused: number; stopped: boolean }>;

/** The reruns the run's log records for the pull request at `head`: those the host took, those it refused, and whether the board stopped. */
function triesAt(ctx: PoolContext, key: string, { url, head }: Readonly<{ url: string; head: string }>): Tries {
  const events = logOf(ctx.store.get(), key).filter((event): event is RerunEvent => event.kind === "cancelled-rerun" && event.url === url && event.head === head);
  return {
    taken: events.filter(({ refused, stopped }) => refused === undefined && stopped === undefined).length,
    refused: events.filter(({ refused }) => refused !== undefined).length,
    stopped: events.some(({ stopped }) => stopped === true),
  };
}

/** The names of the checks whose cancelled runs block `read`, each once. PURE. */
const checksOf = (read: PullFeedback): string[] => [...new Set((read.cancelledRequired ?? []).map(({ name }) => name))];

/** Logs one `cancelled-rerun` event, in the board's own log and in the run's. */
function recordRerun(ctx: PoolContext, key: string, rerun: CancelledRerun): void {
  log(`${key}: ${cancelledRerunWords(rerun)}`);
  update(ctx, (queue) => logEvent(queue, key, ctx.now(), { kind: "cancelled-rerun", ...rerun }));
}

/**
 * Whether the code host says a run of the cancelled runs' workflow has not completed at `head`. A host that cannot tell is read as a quiet head, as the board reran before it could ask; a read that failed (null) or rejected is not a quiet head, and the next watch asks again.
 */
async function headIsBusy(ctx: PoolContext, runs: readonly string[], head: string): Promise<boolean> {
  const { runsInProgress } = ctx.codeHost;
  if (runsInProgress === undefined) return false;
  try {
    return (await runsInProgress.call(ctx.codeHost, runs, head)) !== false;
  } catch {
    return true;
  }
}

/** Reruns the first of the cancelled `runs` and logs it. The host takes one run per call because two reruns of one workflow cancel each other. */
async function rerunOne(ctx: PoolContext, key: string, { url, read }: OpenPull, plan: Readonly<{ runs: readonly string[]; head: string }>): Promise<void> {
  const { runs, head } = plan;
  const { rerunRuns } = ctx.codeHost;
  if (rerunRuns === undefined) return;
  const refused = await rerunRuns.call(ctx.codeHost, [runs[0]]);
  const why = refused === null ? undefined : (shortReason(refused) ?? "no reason given");
  recordRerun(ctx, key, { url, head, checks: checksOf(read), ...(why === undefined ? {} : { refused: why }) });
}

/**
 * What the board does about cancelled runs it has not stopped on, once the head is quiet: it logs the stop when {@link MAX_RERUNS} reruns were taken and the runs still block it, and else reruns one. It waits while a run of the workflow is in progress, which is also
 * what keeps it from reading the rerun it just made, still shown as cancelled, as another cancelled run.
 */
async function actOn(ctx: PoolContext, key: string, pull: OpenPull, plan: Readonly<{ runs: readonly string[]; head: string }>): Promise<void> {
  const { url, read } = pull;
  const { runs, head } = plan;
  const tries = triesAt(ctx, key, { url, head });
  const spent = tries.taken >= MAX_RERUNS;
  if (tries.stopped || (!spent && tries.refused >= MAX_REFUSALS)) return;
  if (await headIsBusy(ctx, runs, head)) return;
  if (spent) recordRerun(ctx, key, { url, head, checks: checksOf(read), stopped: true });
  else await rerunOne(ctx, key, pull, plan);
}

/** The line the card shows for `url` while the board has stopped rerunning, from its log, or none. */
function stopFor(ctx: PoolContext, key: string, { url, read }: OpenPull): CancelledStop | null {
  const { head } = read;
  if (head === null || cancelledGateRuns(read).length === 0 || !triesAt(ctx, key, { url, head }).stopped) return null;
  return { head, note: cancelledRerunWords({ url, head, checks: checksOf(read), stopped: true }) };
}

/** `queue` with the run's stop lines set to `stops`, kept apart from other entries' and set only on a finished run. PURE. */
export const recordCancelledStops = (queue: Queue, key: string, stops: Readonly<Record<string, CancelledStop>>): Queue =>
  replace(queue, key, (entry) => {
    if (entry.phase !== "finished") return entry;
    const { cancelledRerunStopped: _dropped, ...rest } = entry;
    return Object.keys(stops).length === 0 ? rest : { ...rest, cancelledRerunStopped: stops };
  });

/** Sets the run's card line to what the log says of `pull`, written only when it changed. */
function showStop(ctx: PoolContext, entry: Entry, pull: OpenPull): void {
  const key = entry.ticket.key;
  const held = ctx.store.get().entries.find((candidate) => candidate.ticket.key === key)?.cancelledRerunStopped ?? {};
  const { [pull.url]: _was, ...others } = held;
  const stop = stopFor(ctx, key, pull);
  const next = stop === null ? others : { ...others, [pull.url]: stop };
  if (JSON.stringify(next) !== JSON.stringify(held)) update(ctx, (queue) => recordCancelledStops(queue, key, next));
}

/**
 * What the board does about one open pull request of a finished run that sits BLOCKED behind cancelled runs of its required checks: it asks the code host to rerun the first one, on a head where no run of that workflow is in progress, and logs it. It does nothing for a
 * host that cannot rerun a whole run (`rerunRuns` absent). At most {@link MAX_RERUNS} reruns are taken for a head: when the cancelled runs block it past them, the board logs the stop once and the card says so (A11-403). A refusal is logged with its reason, and the
 * next watch asks again until {@link MAX_REFUSALS}.
 */
export async function rerunCancelledGate(ctx: PoolContext, entry: Entry, pull: OpenPull): Promise<void> {
  if (ctx.codeHost.rerunRuns === undefined) return;
  const key = entry.ticket.key;
  const runs = cancelledGateRuns(pull.read);
  const { head } = pull.read;
  if (runs.length > 0 && head !== null) await actOn(ctx, key, pull, { runs, head });
  showStop(ctx, entry, pull);
}
