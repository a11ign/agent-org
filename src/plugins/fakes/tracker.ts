// @ts-check
// module: the in-memory tracker (A11-158) -- the reference that passes `runTrackerConformance`, and what core's tests use in place of Linear
//
// IT HOLDS TICKETS AND NOTHING ELSE. A test seeds them (`seed`), and reads what the board did to them (`ticketOf`, `comments`, `calls`) rather than what core believes it did.
// It implements every optional operation, so a test of the board's planning, ordering or completion has a tracker that takes part; a test of a tracker that has none builds
// its own object, which is a `TicketSource` too.
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_KEYWORDS, type Assignee, type AutomaticCompletionUndo, type Blocker, type People, type PullState, type ScopePage, type StateMove, type Ticket, type TicketSource, type TrackerWriting } from "../contracts/tracker.ts";

/**
 * What the fake declares a new-ticket run files with (contract 1.1): tools of an `mcp__fake__` server, the numbers the contract names, and refusals worded like a real tracker's.
 * A core test of the writer, the hook or the brief builds on this, so it names no real tracker.
 */
export const FAKE_TRACKER_WRITING: TrackerWriting = Object.freeze({
  label: "Fake",
  createTool: "mcp__fake__create_ticket",
  attachTools: ["mcp__fake__prepare_upload", "mcp__fake__attach_upload"],
  filingTools: "^mcp__fake__(?:create_ticket|prepare_upload|attach_upload|attach_file)$",
  refusedInputs: [
    { input: "id", refusal: "is called with an id, which updates an existing ticket: a new-ticket run creates tickets and never updates one" },
    { input: "blocks", refusal: "is called with blocks, which writes a relation on another ticket: a new-ticket run sets parentId, blockedBy and relatedTo only" },
  ],
  attachTicketInput: "ticket",
  createdKey: Object.freeze({ wrapper: "ticket", fields: ["key"] }),
  priorities: Object.freeze({ urgent: 1, high: 2, medium: 3, low: 4, none: 0 }),
  readTools: ["mcp__fake__get_ticket"],
  briefNote: "Use the `mcp__fake__` tools.",
});

/** Who moved a ticket into its completed state, and the state it left (A11-178): what the fake's `undoAutomaticCompletion` reads, as the tracker's history is read. */
type Completion = { by: "integration" | "person"; from: string; fromType: string };

/** A ticket as the fake holds it: the board's ticket, with the state type the tracker would name and the relations the fake records. */
type Held = { ticket: Ticket; statusType: string; blockedBy: string[]; pulls: Record<string, PullState>; titles: Record<string, string>; files: { name: string; text: string }[]; claimant?: string; completion?: Completion };
type Tickets = Map<string, Held>;

const ME: Assignee = { id: "fake-me", name: "Fake Person" };
const FINISHED = ["completed", "canceled"];
/** The time the fake gives a ticket nobody has edited. */
const EPOCH = "2026-01-01T00:00:00.000Z";

/** A ticket with every required field, for a test to seed: only what it names differs. */
export function fakeTicket(key: string, over: Partial<Ticket> = {}): Ticket {
  return { key, title: `Ticket ${key}`, description: `The description of ${key}.`, url: `https://tracker.example.invalid/${key}`, branch: `admin/${key.toLowerCase()}`,
    status: "Todo", statusOrder: 1, team: "FAKE", project: null, priority: 0, parent: null, ...over };
}

const heldOf = (held: Tickets, key: string): Held => {
  const entry = held.get(key);
  if (entry === undefined) throw new RangeError(`fake tracker: no ticket ${JSON.stringify(key)}`);
  return entry;
};

const isOpen = ({ statusType }: Held): boolean => !FINISHED.includes(statusType);

function setStatus(entry: Held, status: string, statusType: string): void {
  entry.ticket = { ...entry.ticket, status, statusType };
  entry.statusType = statusType;
}

/** Complete the ticket as `by`, remembering the state it left, as the tracker's history does. */
function completeBy(entry: Held, by: Completion["by"]): void {
  entry.completion = { by, from: entry.ticket.status, fromType: entry.statusType };
  setStatus(entry, "Done", "completed");
}

/** The project picker's reads (contract 1.8): the projects the open tickets are in, a project's open tickets as one page, and a search of the open tickets by key or by words of the title. */
function projectReadsOf(held: Tickets): Pick<TicketSource, "projects" | "projectPage" | "search"> {
  const open = (): Ticket[] => [...held.values()].filter(isOpen).map(({ ticket }) => ticket);
  return {
    projects: async () => [...new Set(open().flatMap(({ project }) => (project === null ? [] : [project])))].sort().map((name) => ({ id: `project-${name}`, name })),
    projectPage: async (project, after) => ({ tickets: after === null ? open().filter((ticket) => ticket.project === project) : [], next: null }),
    async search(text) {
      const term = text.trim().toLowerCase();
      return term === "" ? [] : open().filter(({ key, title }) => key.toLowerCase() === term || title.toLowerCase().includes(term));
    },
  };
}

/** The reads: what the board lists, looks up and asks of the tracker. */
function readsOf(held: Tickets, calls: string[]): Pick<TicketSource, "assigned" | "viewer" | "me" | "people" | "scoped" | "read" | "download" | "stateTypes" | "texts" | "pullStates" | "blockers" | "projectSummaries" | "claims"> {
  return {
    async assigned() {
      calls.push("assigned");
      return [...held.values()].filter(isOpen).map(({ ticket }) => ({ ...ticket, assignee: ME }));
    },
    viewer: async () => ME.name,
    me: async () => ME,
    async people(): Promise<People> {
      const open = [...held.values()].filter(isOpen).length;
      return { people: [{ ...ME, count: open }], unassigned: 0, total: open };
    },
    scoped: async (_scope: string, after: string | null): Promise<ScopePage> => ({ tickets: after === null ? [...held.values()].map(({ ticket }) => ticket) : [], next: null }),
    async read(key) {
      calls.push(`read ${key}`);
      return held.get(key)?.ticket ?? null;
    },
    async download(ticket, dir) {
      calls.push(`download ${ticket.key}`);
      // A ticket the fake was never seeded with has no files, as a core test that downloads for any ticket it queued expects. A file it holds is written into `dir`, as a download is.
      return (held.get(ticket.key)?.files ?? []).map(({ name, text }) => {
        const path = join(dir, name);
        writeFileSync(path, text);
        return path;
      });
    },
    stateTypes: async (keys) => new Map(keys.flatMap((key) => (held.has(key) ? [[key, heldOf(held, key).statusType] as const] : []))),
    texts: async (keys) => new Map(keys.flatMap((key) => (held.has(key) ? [[key, { description: heldOf(held, key).ticket.description, updatedAt: heldOf(held, key).ticket.updatedAt ?? EPOCH }] as const] : []))),
    // A copy, as a tracker answers a read: a pull request linked after the read must not change what the board recorded from it.
    pullStates: async (keys) => new Map(keys.flatMap((key) => (held.has(key) ? [[key, { ...heldOf(held, key).pulls }] as const] : []))),
    async blockers(keys) {
      const blockerOf = (blocker: string): Blocker => {
        const { statusType, ticket, pulls, titles } = heldOf(held, blocker);
        return { key: blocker, state: statusType, status: ticket.status, pulls, ...(Object.keys(titles).length === 0 ? {} : { titles }) };
      };
      return new Map(keys.flatMap((key): [string, Blocker[]][] => (held.has(key) ? [[key, heldOf(held, key).blockedBy.map(blockerOf)]] : [])));
    },
    claims: async (keys) => new Map(keys.flatMap((key) => (held.get(key)?.claimant === undefined ? [] : [[key, held.get(key)!.claimant!] as const]))),
    projectSummaries: async (keys) => new Map(keys.flatMap((key) => (held.get(key)?.ticket.projectSummary === undefined ? [] : [[key, held.get(key)!.ticket.projectSummary!] as const]))),
  };
}

/** The writes: what the board does to a ticket. Each is idempotent where the contract says so. */
function writesOf(held: Tickets, comments: { key: string; text: string }[], claimed: { key: string; claimant: string }[]): Pick<TicketSource, "attachPlan" | "detachPlan" | "moveToWorkingState" | "restoreState" | "undoAutomaticCompletion" | "addBlockers" | "complete" | "comment" | "updateTicketText" | "claim"> {
  return {
    async attachPlan(key, files, state) {
      const entry = heldOf(held, key);
      for (const file of files) if (!entry.files.some(({ name }) => name === file)) entry.files.push({ name: file, text: "" });
      if (state !== null && entry.statusType === "unstarted") setStatus(entry, state, "started");
      return null;
    },
    async detachPlan(key, titles) {
      const entry = heldOf(held, key);
      entry.files = entry.files.filter(({ name }) => !titles.includes(name) && !titles.includes(basename(name)));
    },
    async moveToWorkingState(key, state) {
      const entry = heldOf(held, key);
      if (entry.statusType !== "unstarted") return { moved: null, note: null };
      const moved: StateMove = { from: entry.ticket.status, to: state };
      setStatus(entry, state, "started");
      return { moved, note: null };
    },
    async restoreState(key, move) {
      const entry = heldOf(held, key);
      if (entry.ticket.status === move.to) setStatus(entry, move.from, "unstarted");
      return null;
    },
    async undoAutomaticCompletion(key, comment): Promise<AutomaticCompletionUndo> {
      const entry = heldOf(held, key);
      if (entry.statusType !== "completed") return { reopened: null, by: "none", note: null };
      const { completion } = entry;
      if (completion === undefined) return { reopened: null, by: "unknown", note: `the fake has no record of who completed ${key}` };
      if (completion.by === "person") return { reopened: null, by: "person", note: null };
      const reopened: StateMove = { from: completion.from, to: entry.ticket.status };
      setStatus(entry, completion.from, completion.fromType);
      delete entry.completion;
      comments.push({ key, text: comment });
      return { reopened, by: "integration", note: null };
    },
    async addBlockers(key, blockerKeys) {
      const entry = heldOf(held, key);
      for (const blocker of blockerKeys) if (!entry.blockedBy.includes(blocker)) entry.blockedBy.push(blocker);
    },
    async complete(key, comment) {
      const entry = heldOf(held, key);
      if (!isOpen(entry)) return null;
      comments.push({ key, text: comment });
      completeBy(entry, "person");
      return null;
    },
    async comment(key, body) {
      heldOf(held, key);
      comments.push({ key, text: body });
    },
    async claim(key, claimant) {
      const entry = heldOf(held, key);
      // Written only when the latest claim names someone else, as the contract says: a repeated claim is no new write.
      if (entry.claimant === claimant) return;
      entry.claimant = claimant;
      claimed.push({ key, claimant });
    },
    async updateTicketText(key, text) {
      const entry = heldOf(held, key);
      entry.ticket = { ...entry.ticket, ...(text.title === undefined ? {} : { title: text.title }), ...(text.description === undefined ? {} : { description: text.description }), updatedAt: new Date(Date.parse(entry.ticket.updatedAt ?? EPOCH) + 1000).toISOString() };
    },
  };
}

export function createFakeTracker(seed: readonly Ticket[] = []) {
  const held: Tickets = new Map();
  const comments: { key: string; text: string }[] = [];
  const calls: string[] = [];
  const claimed: { key: string; claimant: string }[] = [];
  const hold = (ticket: Ticket) => held.set(ticket.key, { ticket, statusType: ticket.statusType ?? "unstarted", blockedBy: [], pulls: {}, titles: {}, files: [] });
  seed.forEach(hold);
  const source: TicketSource = { ...readsOf(held, calls), ...projectReadsOf(held), ...writesOf(held, comments, claimed), keywords: DEFAULT_KEYWORDS };
  return Object.assign(source, {
    /** Add a ticket, or replace the one with its key. */
    seed: hold,
    /** The ticket as the fake holds it now, or undefined. */
    ticketOf: (key: string): Ticket | undefined => held.get(key)?.ticket,
    /** Record a pull request on a ticket, as the tracker would link it, with its title when the tracker has one (contract 1.6). */
    linkPull(key: string, url: string, state: PullState, title?: string) {
      heldOf(held, key).pulls[url] = state;
      if (title !== undefined) heldOf(held, key).titles[url] = title;
    },
    /** Name a file as uploaded to a ticket, with its text, for `download` to write and return. */
    attach(key: string, file: string, text = "") {
      heldOf(held, key).files.push({ name: file, text });
    },
    /** Complete a ticket as the tracker's own integration or as a person would, remembering the state it left, which `undoAutomaticCompletion` reads (A11-178). */
    completeAs(key: string, by: Completion["by"]) {
      completeBy(heldOf(held, key), by);
    },
    /** Set the claimant of a ticket's latest claim, as another instance's `claim` would have left it, or clear it with `undefined`. Records no write. */
    setClaimant(key: string, claimant: string | undefined) {
      heldOf(held, key).claimant = claimant;
    },
    comments,
    /** Every claim the fake wrote, in order: a `claim` that found its claimant already the latest writes none. */
    claimed,
    calls,
  });
}
