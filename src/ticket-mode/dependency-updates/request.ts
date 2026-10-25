// @ts-check
// module: asking the ticket writer for one ticket, and recording that it was asked (A11-255)
import { queueWriter } from "../queue.ts";
import type { WriterForm } from "../queue/queue-entries-and-outcomes.ts";
import { placementOf } from "../writer-placement.ts";
import { firstLine, sayOnce, type SweepContext } from "./context.ts";

/** What one request is: the key it is recorded under, the repository it concerns and the text the writer is given. */
export type TicketRequest = Readonly<{ key: string; repository: string; request: string }>;

/** The form of a request: the repository's clone when the host has one, else none and the writer places the ticket. */
const formOf = (repository: string, clones: Readonly<Record<string, string>>): WriterForm => {
  const name = repository.split("/")[1] ?? "";
  return Object.hasOwn(clones, name) ? { repo: name } : {};
};

/**
 * Ask the writer for one ticket. The key is recorded `requested` first, then the run is queued, and a run the queue refuses (the writer is off or its three places are taken) takes the record back. Answers false when nothing
 * more can be asked this sweep.
 */
export function requestTicket(ctx: SweepContext, { key, repository, request }: TicketRequest): boolean {
  const { deps, state, commit, memory } = ctx;
  const writer = deps.writer();
  if (writer === null) {
    sayOnce(ctx, "dependency updates: this machine names no tickets.writer, so no dependency ticket is asked for");
    return false;
  }
  const before = state.tickets[key];
  const id = `wdep-${deps.now().toString(36)}-${memory.sequence++}`;
  state.tickets[key] = { state: "requested", writerRun: id, at: deps.now(), attempts: before?.state === "failed" ? before.attempts : 0 };
  commit();
  const form = formOf(repository, deps.clones);
  try {
    deps.store.set(queueWriter(deps.store.get(), { id, request, mode: "quick", placement: placementOf(form), form, model: writer.model, effort: writer.effort }, deps.now()));
  } catch (err) {
    if (before === undefined) delete state.tickets[key];
    else state.tickets[key] = before;
    commit();
    deps.log(`dependency updates: ${key} was not asked for (${firstLine(err)}), so the next sweep asks again`);
    return false;
  }
  deps.log(`dependency updates: asked the ticket writer for ${key} (run ${id})`);
  deps.wake();
  return true;
}
