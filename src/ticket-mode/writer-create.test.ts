// no-token: gh -- the tracker is a fake that records each create; nothing reaches Linear
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDrafts, creationOrder, inPickScope, type CreateDeps } from "./writer-create.ts";
import { changeDraft, draftOf, emptyQueue, markWriterRunning, markWriterStarting, queueWriter, writerDrafted, writerOf } from "./queue.ts";
import { type DraftRecord, type Queue } from "./queue/declared-remains.ts";
import { parseTicketSettings, type TicketSettings } from "./settings.ts";
import type { NewTicket, Ticket, TicketSource } from "./source.ts";
import { draftFrom } from "./writer.ts";

const repos = ["agent-org", "nbl-ui-netbox"];
const good = { title: "feat(agent-org): show new-ticket requests", why: "The chairman wants tickets from the board.", doneWhen: ["The board creates a ticket from each draft"] };

/** A ticket as the tracker holds it, with the fields a ticket is read with. */
const ticketOf = (key: string, extra: Partial<Ticket> = {}): Ticket => ({ key, title: `Title ${key}`, description: "", url: `https://linear.app/x/issue/${key}`, branch: key.toLowerCase(),
  status: "Backlog", statusOrder: 0, team: key.split("-")[0], project: null, priority: 0, parent: null, ...extra }) as Ticket;

/** A draft the writer left, as the board holds it, under `id`, from its JSON. It is waiting to be made. */
function recordOf(id: string, file: string, fields: Record<string, unknown>): DraftRecord {
  return { id, file, draft: draftFrom(file, fields, repos), duplicates: [], status: "creating" };
}

/**
 * A board with one writer run whose outcome was read, holding `drafts`, and a tracker that holds `tickets`. `createTicket` makes a ticket by the draft's
 * id, so asking twice with one id makes one. `refuse` names why the tracker refuses a create, or returns nothing to let it through.
 */
function board({ drafts = [recordOf("d1", "01-show.json", good)], tickets = { "A11-12": ticketOf("A11-12", { team: "A11" }), "A11-3": ticketOf("A11-3") },
  pick = "assigned" as TicketSettings["pick"], refuse = () => undefined, warnings = [], createTicket = true, hold }: { drafts?: DraftRecord[];
  tickets?: Record<string, Ticket>; pick?: TicketSettings["pick"]; refuse?: (input: NewTicket) => string | undefined; warnings?: string[];
  createTicket?: boolean; hold?: Promise<void> } = {}) {
  const settings = parseTicketSettings({ clones: { "agent-org": "/r/a", "nbl-ui-netbox": "/r/n" }, stateDir: "/state", tickets: { pick } });
  let queue: Queue = queueWriter(emptyQueue(1), { id: "w1", request: "Show requests", mode: "quick", form: {} }, 1);
  queue = writerDrafted(markWriterRunning(markWriterStarting(queue, "w1", 2), "w1", "ws", "p"), "w1", { drafts, rejected: [] }, 3);
  const created: NewTicket[] = [];
  const byId = new Map<string, Ticket>();
  let next = 100;
  const tracker: TicketSource = {
    assigned: async () => [],
    read: async (key) => tickets[key] ?? null,
    download: async () => [],
    ...(createTicket ? {
      createTicket: async (input: NewTicket) => {
        created.push(input);
        await hold;
        const reason = refuse(input);
        if (reason !== undefined) throw new Error(reason);
        const existing = byId.get(input.id);
        if (existing !== undefined) return { ticket: existing, warnings: [] };
        next += 1;
        const ticket = ticketOf(`NBF-${next}`, { team: input.team ?? "NBF", project: input.project, url: `https://linear.app/x/issue/NBF-${next}` });
        byId.set(input.id, ticket);
        return { ticket, warnings };
      },
    } : {}),
  };
  const deps: CreateDeps = { settings, source: tracker, store: { get: () => queue, set: (next) => { queue = next; } }, now: () => 4 };
  return { deps, created, queue: () => queue, record: (id: string) => draftOf(queue, "w1", id)! };
}

test("the board makes a ticket from each draft, with its project, goal, labels, priority, parent and relations, and keeps the key and address the tracker gave", async () => {
  const fields = { ...good, project: "Visual Explorer - GA", goal: "Keep the board honest", labels: ["Bucket: Board"], priority: "high", parent: "A11-12", blocks: ["A11-3"], blockedBy: ["draft:02-wire"] };
  const drafts = [recordOf("d1", "01-show.json", fields), recordOf("d2", "02-wire.json", good)];
  const { deps, created, record, queue } = board({ drafts });
  await createDrafts(deps, "w1");
  assert.deepEqual(created.map(({ id }) => id), ["d2", "d1"], "the draft it names is made first");
  const input = created[1];
  assert.deepEqual([input.team, input.project, input.goal, input.labels, input.priority, input.parent, input.blocks], ["A11", "Visual Explorer - GA", "Keep the board honest", ["Bucket: Board"], 2, "A11-12", ["A11-3"]]);
  assert.deepEqual(input.blockedBy, ["NBF-101"], "a draft's reference is the key the draft was made as");
  assert.equal(input.description, "**Why:** The chairman wants tickets from the board.\n\n**Done when:**\n\n* The board creates a ticket from each draft\n", "the description is the draft's text");
  assert.equal(record("d1").status, "created");
  assert.deepEqual(record("d1").created, { key: "NBF-102", url: "https://linear.app/x/issue/NBF-102", inPick: true });
  assert.equal(writerOf(queue(), "w1")?.phase, "finished", "the run ends once its drafts are made");
  assert.equal(writerOf(queue(), "w1")?.failure, undefined, "and it has no failure");
});

test("a draft that names another draft is made after it, with the key that one was made as, and a draft that names a draft not made fails naming it", async () => {
  const drafts = [recordOf("d1", "01-show.json", { ...good, parent: "draft:02-wire" }), recordOf("d2", "02-wire.json", good), recordOf("d3", "03-x.json", { ...good, blocks: ["draft:04-missing"] })];
  const { deps, created, record } = board({ drafts, refuse: (input) => (input.title === good.title && input.id === "d2" ? "NBF has no label named Nope" : undefined) });
  await createDrafts(deps, "w1");
  assert.deepEqual(created.map(({ id }) => id), ["d2"], "d2 is asked; d1 and d3 name a draft that was not made, so the tracker is not asked for them");
  assert.equal(record("d2").status, "failed");
  assert.equal(record("d2").failure, "NBF has no label named Nope");
  assert.equal(record("d1").status, "failed");
  assert.equal(record("d1").failure, "parent names draft:02-wire, which was not created");
  assert.equal(record("d3").status, "failed");
  assert.equal(record("d3").failure, "blocks names draft:04-missing, which was not created");
});

test("a draft whose creation the tracker refuses fails the run with its reason, and the tickets already made stay made", async () => {
  const drafts = [recordOf("d1", "01-show.json", good), recordOf("d2", "02-wire.json", { ...good, title: "feat: a second" })];
  const { deps, queue, record } = board({ drafts, refuse: (input) => (input.id === "d1" ? "NBF has no project named Nope; its projects are Visual Explorer - GA" : undefined) });
  await createDrafts(deps, "w1");
  assert.equal(record("d2").status, "created", "the other draft is still made");
  assert.equal(record("d2").created?.key, "NBF-101");
  assert.equal(record("d1").status, "failed");
  const run = writerOf(queue(), "w1")!;
  assert.equal(run.phase, "finished");
  assert.equal(run.failure, "01-show.json was not created: NBF has no project named Nope; its projects are Visual Explorer - GA");
});

test("a restart while a ticket is being created makes one ticket: the draft is asked again with its id, and the tracker gives back the one it made", async () => {
  const { deps, created, record, queue } = board();
  await createDrafts(deps, "w1");
  const first = record("d1").created?.key;
  // A restart after the tracker made the ticket but before the board kept it: the run is `creating` again, and the draft has no key.
  const restarted = changeDraft(queue(), "w1", "d1", (draft) => ({ ...draft, status: "creating", created: undefined }));
  deps.store.set({ ...restarted, writers: restarted.writers!.map((run) => ({ ...run, phase: "creating" as const, finishedAt: undefined })) });
  await createDrafts(deps, "w1");
  assert.equal(created.length, 2, "the tracker was asked again");
  assert.equal(new Set(created.map(({ id }) => id)).size, 1, "with the same id, so it is one ticket");
  assert.equal(record("d1").created?.key, first, "and the board records that one");
});

test("the tracker is asked once while a run's tickets are being made, and a second call for the run waits for nothing new", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const { deps, created } = board({ hold: gate });
  const first = createDrafts(deps, "w1");
  await createDrafts(deps, "w1");
  release();
  await first;
  assert.equal(created.length, 1, "POSITIVE CONTROL: one create reached the tracker for the one draft");
});

test("a stop while the run's tickets are being made leaves the drafts not yet tried failed by the stop, and none is asked", async () => {
  const drafts = [recordOf("d1", "01-show.json", good), recordOf("d2", "02-wire.json", { ...good, title: "feat: a second" })];
  const { deps, created, queue, record } = board({ drafts });
  deps.store.set({ ...queue(), writers: queue().writers!.map((run) => ({ ...run, phase: "finished" as const, failure: "stopped on the board", drafts: run.drafts.map((draft) => ({ ...draft, status: draft.id === "d1" ? "created" as const : "failed" as const, failure: draft.id === "d1" ? undefined : "stopped on the board" })) })) });
  await createDrafts(deps, "w1");
  assert.equal(created.length, 0, "POSITIVE CONTROL: a stopped run asks the tracker for nothing more");
  assert.equal(record("d2").failure, "stopped on the board");
});

test("a tracker that cannot create a ticket fails each draft, saying so, and nothing is created", async () => {
  const { deps, record, queue } = board({ createTicket: false });
  await createDrafts(deps, "w1");
  assert.equal(record("d1").status, "failed");
  assert.equal(record("d1").failure, "this machine's tracker cannot create a ticket");
  assert.equal(writerOf(queue(), "w1")?.failure, "01-show.json was not created: this machine's tracker cannot create a ticket");
});

test("a relation the tracker could not make is a warning on the draft, and the ticket is still created", async () => {
  const { deps, record } = board({ warnings: ["NBF-101 was created, but it did not block A11-3"] });
  await createDrafts(deps, "w1");
  assert.equal(record("d1").status, "created");
  assert.deepEqual(record("d1").warnings, ["NBF-101 was created, but it did not block A11-3"]);
});

test("the team is the draft's, else its parent's, else the one the Pick view names, else none, which the source chooses", async () => {
  const tickets = { "A11-12": ticketOf("A11-12", { team: "A11" }) };
  const team = async (fields: Record<string, unknown>, pick: TicketSettings["pick"] = "assigned") => {
    const { deps, created } = board({ drafts: [recordOf("d1", "01-show.json", { ...good, ...fields })], tickets, pick });
    await createDrafts(deps, "w1");
    return created[0].team;
  };
  assert.equal(await team({ team: "nbf", parent: "A11-12" }), "NBF", "the draft's team, upper-cased, wins");
  assert.equal(await team({ parent: "A11-12" }, { team: "NBF" }), "A11", "the parent's team is next");
  assert.equal(await team({}, { team: "NBF" }), "NBF", "then the team the Pick view names");
  assert.equal(await team({}), null, "and with none, the source chooses by the project or the key's teams");
});

test("a created ticket that Pick does not list is marked so, and the key's own tickets are listed", async () => {
  const { deps, record } = board({ pick: { team: "NBF" } });
  await createDrafts(deps, "w1");
  assert.equal(record("d1").created?.inPick, true, "the team the Pick view names is the team it was made in");
  const other = board({ pick: { project: "Visual" } });
  await createDrafts(other.deps, "w1");
  assert.equal(other.record("d1").created?.inPick, false, "a ticket in no project the Pick view names is not listed");
});

test("the draft order puts each draft after the drafts it names, and a cycle keeps the file order", () => {
  const drafts = [recordOf("d1", "01-a.json", { ...good, blockedBy: ["draft:02-b"] }), recordOf("d2", "02-b.json", good), recordOf("d3", "03-c.json", good)];
  assert.deepEqual(creationOrder(drafts), ["d2", "d1", "d3"]);
  const cycle = [recordOf("d1", "01-a.json", { ...good, blocks: ["draft:02-b"] }), recordOf("d2", "02-b.json", { ...good, blocks: ["draft:01-a"] })];
  assert.deepEqual(creationOrder(cycle), ["d1", "d2"], "neither names a draft made first, so the file order holds, and one fails naming the other");
});

test("the Pick view lists the key's own tickets, and a team's or a project's the view names", () => {
  assert.equal(inPickScope("assigned", { team: "NBF", project: null }), true);
  assert.equal(inPickScope({ team: "NBF" }, { team: "A11", project: null }), false);
  assert.equal(inPickScope({ project: "Visual" }, { team: "NBF", project: "Visual" }), true);
});
