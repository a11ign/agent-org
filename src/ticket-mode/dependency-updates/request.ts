// @ts-check
// module: asking the ticket writer for one ticket, and recording that it was asked (A11-255)
import { queueWriter } from "../queue.ts";
import { MAX_WRITER_RUNS, type WriterForm } from "../queue/queue-entries-and-outcomes.ts";
import { placementOf } from "../writer-placement.ts";
import { firstLine, sayOnce, type SweepContext } from "./context.ts";

/** The new-ticket places a person keeps: the sweep takes no more than the rest, so "New ticket" is never refused for the sweep's requests. */
export const PLACES_KEPT_FOR_PEOPLE = 1;

/** What one request is: the key it is recorded under, the repository it concerns and the text the writer is given, which is written once the team it is filed in is known (A11-267). */
export type TicketRequest = Readonly<{ key: string; repository: string; request: (team: string) => string }>;

/** The form of a request: the repository's clone when the host has one, else none and the writer places the ticket. */
const formOf = (repository: string, clones: Readonly<Record<string, string>>): WriterForm => {
  const name = repository.split("/")[1] ?? "";
  return Object.hasOwn(clones, name) ? { repo: name } : {};
};

/**
 * Ask the writer for one ticket, filed in the team the sweep read (A11-267). The key is recorded `requested` first, then the run is queued, and a run the queue refuses (the writer is off or its three places are taken) takes the record back. Answers false when nothing
 * more can be asked this sweep.
 */
export function requestTicket(ctx: SweepContext, { key, repository, request }: TicketRequest, team: string): boolean {
  const { deps, state, commit, memory } = ctx;
  const writer = deps.writer();
  if (writer === null) {
    sayOnce(ctx, "dependency updates: this machine names no tickets.writer, so no dependency ticket is asked for");
    return false;
  }
  const unfinished = (deps.store.get().writers ?? []).filter((run) => run.phase !== "finished").length;
  if (unfinished >= MAX_WRITER_RUNS - PLACES_KEPT_FOR_PEOPLE) {
    sayOnce(ctx, `dependency updates: ${unfinished} new-ticket requests are unfinished, so the sweep leaves the last place for a person and asks again when one ends`);
    return false;
  }
  const before = state.tickets[key];
  const id = `wdep-${deps.now().toString(36)}-${memory.sequence++}`;
  state.tickets[key] = { state: "requested", writerRun: id, at: deps.now(), attempts: before?.state === "failed" ? before.attempts : 0 };
  commit();
  const form = formOf(repository, deps.clones);
  try {
    deps.store.set(queueWriter(deps.store.get(), { id, request: request(team), mode: "quick", placement: placementOf(form), form, team, model: writer.model, effort: writer.effort }, deps.now()));
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
