// @ts-check
// module: making the tickets a new-ticket run's drafts describe (A11-94, A11-124) -- the ONLY path to a tracker's `createTicket`
//
// NOTHING IS REVIEWED. When a writer run's outcome is read, this module makes a ticket from each valid draft, in the tracker, with the instance's key,
// assigned to the person whose key it is, and the run ends. A draft that names another draft (`draft:<stem>` in parent, blocks or blockedBy) is made
// after it, with its key. The writer run and the workers have no tracker tool that creates (`hook.ts` allows a writer only its reads), so the tracker sees
// a create from this process alone.
//
// The state is kept before the tracker is asked (`creating`) and after (`created` with the key, or `failed` with the tracker's reason), so the board
// shows what happened. A draft's id is the ticket's own id, so a creation asked again after a restart makes no second ticket: the tracker returns the
// ticket it already has.
import { changeDraft, draftOf, writerCreated, writerOf } from "./queue.ts";
import type { DraftRecord, Queue } from "./queue/declared-remains.ts";
import type { PickScope, TicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { descriptionOf, PRIORITY_NUMBER, stemOf } from "./writer.ts";
import type { QueueStore } from "./pool.ts";

/** What the board needs to make a run's tickets: the settings, the tracker, the queue, and the clock. */
export type CreateDeps = Readonly<{ settings: TicketSettings; source: TicketSource; store: QueueStore; now: () => number }>;

/** The team a draft's ticket goes in when the draft names none and the Pick view names one: the team `tickets.pick` lists, or null. */
export const pickTeamOf = (pick: PickScope): string | null => (typeof pick === "object" && "team" in pick ? pick.team : null);

/** Whether a created ticket is in the Pick view's list, so the board can say when it is not. The key's own tickets are, since they are assigned to it. */
export function inPickScope(pick: PickScope, ticket: Pick<Ticket, "team" | "project">): boolean {
  if (pick === "assigned") return true;
  if ("team" in pick) return ticket.team === pick.team;
  return ticket.project === pick.project;
}

/**
 * The key of a draft's relation: a ticket's key as it is, or the key of the draft a `draft:<stem>` names, which must have been made first. Throws naming
 * the field and the draft when that draft was not made. Reads the queue only.
 */
function keyOf(queue: Queue, run: string, ref: string, field: string): string {
  if (!ref.startsWith("draft:")) return ref;
  const stem = ref.slice("draft:".length);
  const other = (writerOf(queue, run)?.drafts ?? []).find((record) => stemOf(record.file) === stem);
  if (other?.status !== "created" || other.created === undefined) throw new Error(`${field} names ${ref}, which was not created`);
  return other.created.key;
}

/**
 * The order a run's drafts are made in: each after the drafts it names, with the file order where none names another. A cycle is not an error here: the
 * drafts in it keep the file order, and one of them then fails naming the other, since it is not made yet. PURE.
 */
export function creationOrder(drafts: readonly DraftRecord[]): string[] {
  const stemOfId = new Map(drafts.map((record) => [stemOf(record.file), record.id]));
  const namesOf = (record: DraftRecord): string[] => [record.draft.parent, ...record.draft.blocks, ...record.draft.blockedBy]
    .flatMap((ref) => (ref?.startsWith("draft:") ? [stemOfId.get(ref.slice("draft:".length))] : []))
    .filter((id): id is string => id !== undefined && id !== record.id);
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < drafts.length) {
    const next = drafts.find((record) => !done.has(record.id) && namesOf(record).every((id) => done.has(id)));
    const pick = next ?? drafts.find((record) => !done.has(record.id));
    if (pick === undefined) break;
    done.add(pick.id);
    order.push(pick.id);
  }
  return order;
}

/** The run ids whose drafts this process is making now: a second call for one is a no-op, so the tracker is asked once per draft at a time. */
const making = new Set<string>();

/**
 * Make the tickets of writer run `run`'s drafts, in order, and end the run once each is made or refused. A draft that the tracker refuses, or that names a
 * draft that was not made, is `failed` with why, and the others are still made. A stop while this runs leaves the drafts not yet tried failed by the stop,
 * and nothing more is made. A restart while it runs is picked up again by `reconcile`, and the drafts still `creating` are asked again with their ids.
 */
export async function createDrafts(deps: CreateDeps, run: string): Promise<void> {
  if (making.has(run)) return;
  making.add(run);
  try {
    for (const id of creationOrder(writerOf(deps.store.get(), run)?.drafts ?? [])) {
      if (writerOf(deps.store.get(), run)?.phase !== "creating") break;
      if (draftOf(deps.store.get(), run, id)?.status !== "creating") continue;
      await makeDraft(deps, run, id);
    }
    if (writerOf(deps.store.get(), run)?.phase === "creating") deps.store.set(writerCreated(deps.store.get(), run, deps.now()));
  } finally {
    making.delete(run);
  }
}

/** Make one draft's ticket: the tracker is asked with the draft's id, and its answer is kept on the draft. */
async function makeDraft({ settings, source, store }: CreateDeps, run: string, id: string): Promise<void> {
  const record = draftOf(store.get(), run, id);
  if (record === undefined) return;
  const keep = (change: (draft: DraftRecord) => DraftRecord) => store.set(changeDraft(store.get(), run, id, change));
  const failed = (error: unknown) => keep((draft) => ({ ...draft, status: "failed", failure: String((error as Error)?.message ?? error).split("\n")[0] }));
  if (source.createTicket === undefined) return failed(new Error("this machine's tracker cannot create a ticket"));
  const { draft } = record;
  try {
    const parent = draft.parent === null ? null : keyOf(store.get(), run, draft.parent, "parent");
    const blocks = draft.blocks.map((ref) => keyOf(store.get(), run, ref, "blocks"));
    const blockedBy = draft.blockedBy.map((ref) => keyOf(store.get(), run, ref, "blockedBy"));
    const parentTeam = parent === null ? null : (await source.read(parent))?.team ?? null;
    const team = draft.team ?? parentTeam ?? pickTeamOf(settings.pick);
    const made = await source.createTicket({
      id, team, title: draft.title, description: descriptionOf(draft, record.duplicates), project: draft.project, goal: draft.goal, labels: draft.labels,
      priority: PRIORITY_NUMBER[draft.priority], parent, blocks, blockedBy,
    });
    keep((current) => ({ ...current, status: "created", created: { key: made.ticket.key, url: made.ticket.url, inPick: inPickScope(settings.pick, made.ticket) },
      failure: undefined, warnings: made.warnings }));
  } catch (err) {
    failed(err);
  }
}
