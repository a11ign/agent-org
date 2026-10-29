// @ts-check
// module: the cancelled duplicate run of a required check that blocks an approved, armed pull request (A11-342) -- the board reruns it once, on its own
//
// ONE PUSH CAN START TWO `ci` RUNS FOR ONE HEAD, AND A CONCURRENCY GROUP CANCELS ONE OF THEM. a11ign/announcement-emulator#32 at `8b3d0ba9`, 2026-10-27: a push and the edit of the pull request's body (both `pull_request` events that `ci.yml` listens to)
// started runs 40438392487 and 40438392613 at 02:26:05, the group cancelled the second, and the cancelled `gate` held the merge although the first run's `gate` was green. The pull request was approved at 07:53 and armed, GitHub kept
// `mergeStateStatus` at BLOCKED and never queued it, and the board showed it as approved and armed with nothing to act on, until a session reran the cancelled run by hand and the pull request went CLEAN within a minute.
//
// THE BOARD RERUNS THAT RUN, ONCE FOR A HEAD. A pull request is the case when it is open, approved at its head, armed, BLOCKED, and the only non-green runs of its required checks there are cancelled ones (`PullFeedback.cancelledRequired`). The
// code host reruns each cancelled run whole (`rerunRuns`, `gh run rerun <id>`), no worker is asked, and the run's log records it (`cancelled-rerun`). THE ONCE BOUND IS THE LOG, which outlives a restart of the board: a head whose log already
// holds a rerun for the pull request is not rerun again, so a rerun that is cancelled again waits for a person and for the next push. A rerun the host REFUSES is logged with its reason and asked again at the next watch, up to {@link MAX_REFUSALS}
// times for a head, so a refusal that cannot change does not become a call at every watch for ever. A pull request that is not approved, not armed, not blocked, or blocked on anything else is left alone.
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import { reviewAtHead } from "./pool-settle.ts";
import type { PoolContext } from "./pool-context.ts";
import { log, update } from "./pool-state.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { logEvent, logOf, shortReason, type RunEvent } from "./queue/run-log.ts";
import { type CancelledRerun, cancelledRerunWords } from "./board-view/cancelled-rerun-words.ts";

/** How many refused reruns the board puts up with for one head before it stops asking. */
export const MAX_REFUSALS = 3;

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

/** The reruns the run's log records for the pull request at `head`, refused or not. */
const triesAt = (ctx: PoolContext, key: string, { url, head }: Readonly<{ url: string; head: string }>): readonly RerunEvent[] =>
  logOf(ctx.store.get(), key).filter((event): event is RerunEvent => event.kind === "cancelled-rerun" && event.url === url && event.head === head);

/** Whether the board has done what it does for the head: a rerun that the host took, or {@link MAX_REFUSALS} refusals. PURE. */
const doneAt = (tries: readonly RerunEvent[]): boolean => tries.some(({ refused }) => refused === undefined) || tries.length >= MAX_REFUSALS;

/** The names of the checks whose cancelled runs block `read`, each once. PURE. */
const checksOf = (read: PullFeedback): string[] => [...new Set((read.cancelledRequired ?? []).map(({ name }) => name))];

/** What the board asks the code host for one pull request: the addresses of the cancelled runs to rerun and the head they block, or null when there is nothing to ask: no such runs, no head, or a head the log already records the board done with. */
function rerunPlan(ctx: PoolContext, key: string, { url, read }: OpenPull): Readonly<{ runs: readonly string[]; head: string }> | null {
  const runs = cancelledGateRuns(read);
  const { head } = read;
  if (runs.length === 0 || head === null) return null;
  return doneAt(triesAt(ctx, key, { url, head })) ? null : { runs, head };
}

/**
 * What the board does about one open pull request of a finished run that sits BLOCKED behind cancelled runs of its required checks: it asks the code host to rerun them, once for the head, and logs it. It does nothing for a host that cannot rerun a whole run
 * (`rerunRuns` absent), and for a pull request the log already records a rerun for at this head. A refusal is logged with its reason, and the next watch asks again until {@link MAX_REFUSALS}.
 */
export async function rerunCancelledGate(ctx: PoolContext, entry: Entry, pull: OpenPull): Promise<void> {
  if (ctx.codeHost.rerunRuns === undefined) return;
  const key = entry.ticket.key;
  const plan = rerunPlan(ctx, key, pull);
  if (plan === null) return;
  const { url, read } = pull;
  const { runs, head } = plan;
  const refused = await ctx.codeHost.rerunRuns(runs);
  const checks = checksOf(read);
  const why = refused === null ? undefined : (shortReason(refused) ?? "no reason given");
  const rerun: CancelledRerun = { url, head, checks, ...(why === undefined ? {} : { refused: why }) };
  log(`${key}: ${cancelledRerunWords(rerun)}`);
  update(ctx, (queue) => logEvent(queue, key, ctx.now(), { kind: "cancelled-rerun", ...rerun }));
}
