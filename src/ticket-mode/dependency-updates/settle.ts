// @ts-check
// module: reading what each request came to, and queueing the ticket the writer made (A11-255)
//
// A run still going is left. One that made a ticket is `filed` and, when it made exactly one and ended well, that ticket is queued as a person's add would queue it. One that made none is `failed`, to be asked again later.
import { writerOf } from "../queue.ts";
import type { WriterRun } from "../queue/queue-entries-and-outcomes.ts";
import type { Ticket } from "../source.ts";
import { firstLine, sayOnce, type SweepContext } from "./context.ts";
import type { Requested } from "./filed.ts";

/** Read the state of every request: the ones the writer has finished are filed or failed, and a filed ticket not yet queued is queued. */
export async function settleRequests(ctx: SweepContext): Promise<void> {
  for (const [key, entry] of Object.entries(ctx.state.tickets)) {
    if (entry.state === "filed" && entry.queue && !entry.queued) await queueFiled(ctx, key, entry.ticket);
    if (entry.state === "requested") await settleRun(ctx, key, entry);
  }
}

/** One request whose run may have ended. */
async function settleRun(ctx: SweepContext, key: string, entry: Requested): Promise<void> {
  const { deps, state, commit } = ctx;
  const run = writerOf(deps.store.get(), entry.writerRun);
  if (run === undefined) {
    // The run is not on the board (dismissed, or never saved): the request is taken back. The writer's own search for a duplicate is the guard against a ticket it made.
    delete state.tickets[key];
    commit();
    deps.log(`dependency updates: the writer run ${entry.writerRun} for ${key} is not on the board, so the next sweep asks again`);
  } else if (run.phase === "finished") {
    recordEnd(ctx, key, entry, run);
    commit();
    const filed = state.tickets[key];
    if (filed?.state === "filed" && filed.queue) await queueFiled(ctx, key, filed.ticket);
  }
}

/** Record how a finished run ended: with no ticket it is failed; with any it is filed, and queued only for exactly one ticket and no failure. */
function recordEnd({ deps, state }: SweepContext, key: string, entry: Requested, run: WriterRun): void {
  if (run.tickets.length === 0) {
    const reason = run.failure ?? "the run made no ticket";
    state.tickets[key] = { state: "failed", attempts: entry.attempts + 1, at: deps.now(), reason };
    deps.log(`dependency updates: the writer run ${entry.writerRun} for ${key} made no ticket (${reason})`);
    return;
  }
  const ticket = run.tickets[0]!.key;
  const queue = run.tickets.length === 1 && run.failure === undefined;
  state.tickets[key] = { state: "filed", ticket, queue, queued: false };
  if (!queue) deps.log(`dependency updates: the writer run ${entry.writerRun} for ${key} ended with ${run.tickets.length} ticket(s) and ${run.failure ?? "no failure"}, so ${ticket} is not queued: a person decides`);
}

/** Put the ticket the writer made on the queue, as a person's add would. A ticket the tracker cannot be read for yet is tried again next sweep; one the queue refuses is left for a person. */
async function queueFiled(ctx: SweepContext, key: string, ticket: string): Promise<void> {
  const { deps, state, commit } = ctx;
  let read: Ticket | null;
  try {
    read = await deps.source.read(ticket);
  } catch (err) {
    sayOnce(ctx, `dependency updates: ${ticket} could not be read from the tracker (${firstLine(err)}), so the next sweep queues it`);
    return;
  }
  if (read === null) {
    sayOnce(ctx, `dependency updates: ${ticket} is not in the tracker yet, so the next sweep queues it`);
    return;
  }
  try {
    deps.queueTickets([read], deps.runChoice(), { plan: false });
    state.tickets[key] = { state: "filed", ticket, queue: true, queued: true };
    deps.log(`dependency updates: queued ${ticket} for ${key}`);
  } catch (err) {
    state.tickets[key] = { state: "filed", ticket, queue: false, queued: false };
    deps.log(`dependency updates: ${ticket} was not queued (${firstLine(err)}): a person queues it`);
  }
  commit();
}
