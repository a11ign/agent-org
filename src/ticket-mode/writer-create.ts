// @ts-check
// module: creating the ticket a person approved on the board (A11-94) -- the ONLY path to a tracker's `createTicket`
//
// NOTHING IS CREATED WITHOUT A PERSON'S APPROVAL. A writer run leaves drafts; this module makes a ticket from one, and only when the approve route
// calls it. A discard calls nothing. The writer run and the workers have no tracker tool that creates (`hook.ts` allows a writer only its reads), so
// the tracker sees a create from this process alone, with the instance's key.
//
// THE PERSON'S FINAL EDIT IS WHAT IS CREATED. The edited fields are checked with the draft format's own rules (`draftFrom`), and a draft that names a
// duplicate is created only once the person has acknowledged it. A draft that names another draft waits for that one, and is created with its key.
// The state is kept before the tracker is asked: `creating` while it is, `created` with the key after, and `pending` again, with the tracker's reason,
// when it refuses. An approve that is retried, or sent twice, makes one ticket, because the draft's own id is the ticket's id.
import type { QueueStore } from "./pool.ts";
import { changeDraft, draftOf, writerOf, type DraftRecord, type Queue } from "./queue.ts";
import type { PickScope, TicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { descriptionOf, draftFrom, DraftRefusal, type Draft, PRIORITY_NUMBER, stemOf } from "./writer.ts";

/** A refusal the person can act on: the message names what to change. */
export class WriterRefusal extends Error {}

/** What the board needs to create a ticket: the settings, the tracker, the queue, and how a ticket is queued. */
export type CreateDeps = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  store: QueueStore;
  /** Queue a created ticket exactly as the Queue button does, with the saved choice, and planned first when `plan` is true. */
  queueTicket: (ticket: Ticket, plan: boolean) => void;
}>;

/** The approve route's request: the draft's fields as the person left them, and what to do with the ticket once it exists. */
export type Approval = Readonly<{
  run: string;
  draft: string;
  /** The draft's fields as edited. Absent, the draft is created as the writer left it. */
  fields?: unknown;
  acknowledgeDuplicates?: boolean;
  queue?: boolean;
  plan?: boolean;
}>;

/** A ticket the board created, with what the board needs to show about it. */
export type Created = Readonly<{ key: string; url: string; warnings: readonly string[]; queued: boolean; queueError: string | null; inPick: boolean }>;

/** The team a draft's ticket goes in when the draft names none and the Pick view names one: the team `tickets.pick` lists, or null. */
export const pickTeamOf = (pick: PickScope): string | null => (typeof pick === "object" && "team" in pick ? pick.team : null);

/** Whether a created ticket is in the Pick view's list, so the board can say when it is not. The key's own tickets are, since they are assigned to it. */
export function inPickScope(pick: PickScope, ticket: Pick<Ticket, "team" | "project">): boolean {
  if (pick === "assigned") return true;
  if ("team" in pick) return ticket.team === pick.team;
  return ticket.project === pick.project;
}

/** The record of draft `draftId` in the writer run `run`, or a refusal naming what is missing. */
function recordOf(queue: Queue, run: string, draftId: string): DraftRecord {
  if (writerOf(queue, run) === undefined) throw new WriterRefusal(`there is no new-ticket request ${run}`);
  const record = draftOf(queue, run, draftId);
  if (record === undefined) throw new WriterRefusal(`there is no draft ${draftId} in ${run}`);
  return record;
}

/**
 * The fields a draft is created from: the person's edit, checked with the draft format's own rules, which name the field at fault. `stems` are the
 * other drafts of the request, which a `draft:` reference may name.
 */
function checkedFields(file: string, fields: unknown, repos: readonly string[], stems: ReadonlySet<string>): Draft {
  try {
    return draftFrom(file, fields, repos, stems);
  } catch (err) {
    if (err instanceof DraftRefusal) throw new WriterRefusal(err.message);
    throw err;
  }
}

/**
 * The key of a draft's relation: a ticket's key as it is, or the key of the draft a `draft:<stem>` names, which must be created first. Reads the queue
 * only.
 */
function keyOf(queue: Queue, run: string, ref: string, field: string): string {
  if (!ref.startsWith("draft:")) return ref;
  const stem = ref.slice("draft:".length);
  const other = (writerOf(queue, run)?.drafts ?? []).find((record) => stemOf(record.file) === stem);
  if (other?.status !== "created" || other.created === undefined) throw new WriterRefusal(`${field} names ${ref}: approve ${stem} first`);
  return other.created.key;
}

/**
 * Approve a draft: create its ticket in the tracker, assigned to the key's own user, and, when asked, queue it. A refusal the person can act on is
 * thrown as a {@link WriterRefusal} and leaves the draft pending, editable, with the reason on it. A draft already created is answered with its
 * ticket, and nothing is created twice.
 */
/**
 * The drafts this process is creating now, by id. A second approve of one of them is refused while the first is in flight, so the tracker is asked once.
 * A draft a restart left `creating` is not in this set, so its retry goes through.
 */
const inFlight = new Set<string>();

export async function approveDraft({ settings, source, store, queueTicket }: CreateDeps, input: Approval): Promise<Created> {
  const record = recordOf(store.get(), input.run, input.draft);
  if (record.status === "discarded") throw new WriterRefusal(`${record.file} was discarded, so it creates nothing`);
  if (record.status === "created" && record.created !== undefined) {
    const { key, url } = record.created;
    // A ticket the tracker can no longer read is not known to be outside the Pick view, so it is not said to be.
    const found = await source.read(key).catch(() => null);
    const queued = input.queue !== true ? { queued: false, queueError: null }
      : found === null ? { queued: false, queueError: `no ticket ${key} to queue` } : queueOrRefuse(queueTicket, found, input.plan === true);
    return { key, url, warnings: record.warnings ?? [], inPick: found === null || inPickScope(settings.pick, found), ...queued };
  }
  const run = writerOf(store.get(), input.run);
  const stems = new Set((run?.drafts ?? []).map((other) => stemOf(other.file)));
  const repos = Object.keys(settings.clones);
  // The duplicates are the ones the writer named, not the person's edit: an edit cannot drop one and so skip its acknowledgement.
  const draft: Draft = { ...checkedFields(record.file, input.fields ?? record.draft, repos, stems), duplicates: record.draft.duplicates };
  if (draft.duplicates.length > 0 && input.acknowledgeDuplicates !== true) {
    throw new WriterRefusal(`${record.file} names ${draft.duplicates.map(({ key }) => key).join(", ")} as a duplicate: check that it is one before you approve`);
  }
  const parent = draft.parent === null ? null : keyOf(store.get(), input.run, draft.parent, "parent");
  const blocks = draft.blocks.map((ref) => keyOf(store.get(), input.run, ref, "blocks"));
  const blockedBy = draft.blockedBy.map((ref) => keyOf(store.get(), input.run, ref, "blockedBy"));
  if (source.createTicket === undefined) throw new WriterRefusal("this machine's tracker cannot create a ticket, so nothing was created");
  if (inFlight.has(record.id)) throw new WriterRefusal(`${record.file} is being created already: wait for that to finish`);
  // The mark comes before any await, so a second approve that arrives now finds the draft creating, not pending.
  inFlight.add(record.id);
  store.set(changeDraft(store.get(), input.run, input.draft, (current) => ({ ...current, draft, status: "creating", failure: undefined })));
  let made: Readonly<{ ticket: Ticket; warnings: readonly string[] }>;
  try {
    const parentTeam = parent === null ? null : (await source.read(parent))?.team ?? null;
    const team = draft.team ?? parentTeam ?? pickTeamOf(settings.pick);
    made = await source.createTicket({
      id: record.id, team, title: draft.title, description: descriptionOf(draft), project: draft.project, goal: draft.goal, labels: draft.labels,
      priority: PRIORITY_NUMBER[draft.priority], parent, blocks, blockedBy,
    });
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).split("\n")[0];
    store.set(changeDraft(store.get(), input.run, input.draft, (current) => ({ ...current, status: "pending", failure: reason })));
    throw new WriterRefusal(`${reason}. Nothing was created; change the draft and approve it again.`);
  } finally {
    inFlight.delete(record.id);
  }
  store.set(changeDraft(store.get(), input.run, input.draft, (current) => ({ ...current, status: "created", created: { key: made.ticket.key, url: made.ticket.url },
    failure: undefined, warnings: made.warnings })));
  const queued = input.queue === true ? queueOrRefuse(queueTicket, made.ticket, input.plan === true) : { queued: false, queueError: null };
  return { key: made.ticket.key, url: made.ticket.url, warnings: made.warnings, inPick: inPickScope(settings.pick, made.ticket), ...queued };
}

/** Queue a ticket, or say why it could not be: a created ticket stays created, and the board shows the reason. */
function queueOrRefuse(queueTicket: CreateDeps["queueTicket"], ticket: Ticket, plan: boolean): Readonly<{ queued: boolean; queueError: string | null }> {
  try {
    queueTicket(ticket, plan);
    return { queued: true, queueError: null };
  } catch (err) {
    return { queued: false, queueError: String((err as Error)?.message ?? err).split("\n")[0] };
  }
}

/**
 * Discard a draft: it is kept on the board as discarded, and nothing is created or changed in the tracker. A draft already created stays as it is.
 */
export function discardDraft({ store }: Pick<CreateDeps, "store">, input: Readonly<{ run: string; draft: string }>): void {
  const record = recordOf(store.get(), input.run, input.draft);
  if (record.status === "created") throw new WriterRefusal(`${record.file} is created already as ${record.created?.key ?? "a ticket"}, so it cannot be discarded`);
  if (record.status === "creating") throw new WriterRefusal(`${record.file} is being created, so it cannot be discarded until that ends`);
  store.set(changeDraft(store.get(), input.run, input.draft, (current) => ({ ...current, status: "discarded" })));
}
