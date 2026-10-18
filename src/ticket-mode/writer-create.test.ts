// no-token: gh -- the tracker is a fake that records each create; nothing reaches Linear
import { test } from "node:test";
import assert from "node:assert/strict";
import { discardDraft, approveDraft, inPickScope, WriterRefusal, type CreateDeps } from "./writer-create.ts";
import { changeDraft, draftOf, emptyQueue, markWriterRunning, markWriterStarting, queueWriter, writerDrafted, writerOf, type DraftRecord, type Queue } from "./queue.ts";
import { parseTicketSettings, type TicketSettings } from "./settings.ts";
import type { NewTicket, Ticket, TicketSource } from "./source.ts";
import { descriptionOf, draftFrom } from "./writer.ts";

const repos = ["agent-org", "nbl-ui-netbox"];
const good = { title: "feat(agent-org): show new-ticket requests", why: "The chairman wants tickets from the board.", doneWhen: ["The board creates an approved draft"] };

/** A ticket as the tracker holds it, with the fields a ticket is read with. */
const ticketOf = (key: string, extra: Partial<Ticket> = {}): Ticket => ({ key, title: `Title ${key}`, description: "", url: `https://linear.app/x/issue/${key}`, branch: key.toLowerCase(),
  status: "Backlog", statusOrder: 0, team: key.split("-")[0], project: null, priority: 0, parent: null, ...extra }) as Ticket;

/** A draft the writer left, as the board holds it, under `id`, from its JSON. */
function recordOf(id: string, file: string, fields: Record<string, unknown>): DraftRecord {
  return { id, file, draft: draftFrom(file, fields, repos), duplicates: [], status: "pending" };
}

/**
 * A board with one writer run that left `drafts`, a tracker that holds `tickets`, and the calls it receives. `createTicket` makes a ticket by the
 * draft's id, so asking twice with one id makes one; `refuse` names a reason the tracker refuses every create with.
 */
function board({ drafts = [recordOf("d1", "01-show.json", good)], tickets = { "A11-12": ticketOf("A11-12", { team: "A11" }), "A11-3": ticketOf("A11-3") }, pick = "assigned" as TicketSettings["pick"],
  refuse, warnings = [], createTicket = true, hold }: { drafts?: DraftRecord[]; tickets?: Record<string, Ticket>; pick?: TicketSettings["pick"]; refuse?: string;
  warnings?: string[]; createTicket?: boolean; hold?: Promise<void> } = {}) {
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
        if (refuse !== undefined) throw new Error(refuse);
        const existing = byId.get(input.id);
        if (existing !== undefined) return { ticket: existing, warnings: [] };
        next += 1;
        const ticket = ticketOf(`NBF-${next}`, { team: input.team ?? "NBF", project: input.project, url: `https://linear.app/x/issue/NBF-${next}` });
        byId.set(input.id, ticket);
        return { ticket, warnings };
      },
    } : {}),
  };
  const queued: { key: string; plan: boolean }[] = [];
  const deps: CreateDeps = { settings, source: tracker, store: { get: () => queue, set: (next) => { queue = next; } }, queueTicket: (ticket, plan) => { queued.push({ key: ticket.key, plan }); } };
  return { deps, created, queued, queue: () => queue, record: (id: string) => draftOf(queue, "w1", id)! };
}

test("approve creates the ticket with its project, goal, labels, priority, parent and relations, and keeps the key and address it was given", async () => {
  const fields = { ...good, project: "Visual Explorer - GA", goal: "Keep the board honest", labels: ["Bucket: Board"], priority: "high", parent: "A11-12", blocks: ["A11-3"], blockedBy: ["draft:02-wire"] };
  const drafts = [recordOf("d1", "01-show.json", fields), recordOf("d2", "02-wire.json", good)];
  const { deps, created, record, queue } = board({ drafts });
  await assert.rejects(approveDraft(deps, { run: "w1", draft: "d1" }), /names draft:02-wire: approve 02-wire first/, "a draft waits for the one it names");
  assert.equal(created.length, 0);
  const first = await approveDraft(deps, { run: "w1", draft: "d2" });
  assert.equal(first.key, "NBF-101");
  const made = await approveDraft(deps, { run: "w1", draft: "d1" });
  assert.equal(made.key, "NBF-102");
  const input = created[1];
  assert.equal(input.id, "d1");
  assert.deepEqual([input.team, input.project, input.goal, input.labels, input.priority, input.parent, input.blocks], ["A11", "Visual Explorer - GA", "Keep the board honest", ["Bucket: Board"], 2, "A11-12", ["A11-3"]]);
  assert.deepEqual(input.blockedBy, ["NBF-101"], "a draft's reference is the key the draft was created as");
  assert.equal(input.description, descriptionOf(draftFrom("01-show.json", fields, repos)));
  assert.equal(record("d1").status, "created");
  assert.deepEqual(record("d1").created, { key: "NBF-102", url: "https://linear.app/x/issue/NBF-102" });
  assert.equal(queue().writers?.[0].drafts.length, 2);
});

test("the team is the draft's, else its parent's, else the one the Pick view names, else none, which the source chooses", async () => {
  const tickets = { "A11-12": ticketOf("A11-12", { team: "A11" }) };
  const team = async (fields: Record<string, unknown>, pick: TicketSettings["pick"] = "assigned") => {
    const { deps, created } = board({ drafts: [recordOf("d1", "01-show.json", { ...good, ...fields })], tickets, pick });
    await approveDraft(deps, { run: "w1", draft: "d1" });
    return created[0].team;
  };
  assert.equal(await team({ team: "nbf", parent: "A11-12" }), "NBF", "the draft's team, upper-cased, wins");
  assert.equal(await team({ parent: "A11-12" }, { team: "NBF" }), "A11", "the parent's team is next");
  assert.equal(await team({}, { team: "NBF" }), "NBF", "then the team the Pick view names");
  assert.equal(await team({}), null, "and with none, the source chooses by the project or the key's teams");
});

test("an unresolvable name is refused with what the tracker said, and nothing is created: the draft stays pending, editable, with the reason", async () => {
  const { deps, record } = board({ refuse: "NBF has no project named Nope; its projects are Visual Explorer - GA" });
  await assert.rejects(approveDraft(deps, { run: "w1", draft: "d1", fields: { ...good, project: "Nope" } }), (err: unknown) =>
    err instanceof WriterRefusal && /has no project named Nope.*Nothing was created/.test(err.message));
  assert.equal(record("d1").status, "pending");
  assert.match(record("d1").failure ?? "", /has no project named Nope/);
});

test("a draft that names a duplicate is created only once the person acknowledges it, and the refusal names the duplicate", async () => {
  const fields = { ...good, duplicates: [{ key: "A11-9", why: "same request" }] };
  const { deps, created } = board({ drafts: [recordOf("d1", "01-show.json", fields)] });
  await assert.rejects(approveDraft(deps, { run: "w1", draft: "d1" }), /names A11-9 as a duplicate/);
  assert.equal(created.length, 0, "POSITIVE CONTROL: refused without the acknowledgement, nothing is created");
  await approveDraft(deps, { run: "w1", draft: "d1", acknowledgeDuplicates: true });
  assert.equal(created.length, 1);
});

test("an edit that drops a duplicate the writer named is still refused until it is acknowledged", async () => {
  const named = recordOf("d1", "01-show.json", { ...good, duplicates: [{ key: "A11-9", why: "same request" }] });
  const { deps, created } = board({ drafts: [{ ...named, duplicates: [{ key: "A11-9", why: "same request", title: "Show", url: "u" }] }] });
  await assert.rejects(approveDraft(deps, { run: "w1", draft: "d1", fields: { ...good, duplicates: [] } }), /names A11-9 as a duplicate/);
  assert.equal(created.length, 0, "POSITIVE CONTROL: the edit left the duplicate out, and nothing is created");
});

test("a second approve while the first is still creating is refused, and the tracker is asked once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const { deps, created } = board({ hold: gate });
  const first = approveDraft(deps, { run: "w1", draft: "d1" });
  await assert.rejects(approveDraft(deps, { run: "w1", draft: "d1" }), /is being created already/, "POSITIVE CONTROL: the second press is refused while the first is in flight");
  release();
  assert.equal((await first).key, "NBF-101");
  assert.equal(created.length, 1, "one create reached the tracker");
});

test("a parent that cannot be read leaves the draft pending, not creating, so it can be approved again", async () => {
  const { deps, record } = board({ drafts: [recordOf("d1", "01-show.json", { ...good, parent: "A11-12" })] });
  const failing = { ...deps, source: { ...deps.source, read: async () => { throw new Error("Linear answered 500"); } } };
  await assert.rejects(approveDraft(failing, { run: "w1", draft: "d1" }), /Linear answered 500/);
  assert.equal(record("d1").status, "pending");
});

test("approving twice, or again after a restart left a draft creating, makes one ticket", async () => {
  const { deps, created, record } = board();
  await approveDraft(deps, { run: "w1", draft: "d1" });
  const again = await approveDraft(deps, { run: "w1", draft: "d1" });
  assert.equal(again.key, "NBF-101", "the second press answers with the ticket it made");
  assert.equal(record("d1").status, "created");
  assert.equal(created.length, 1, "no second create: a created draft is answered, not sent to the tracker");
  // A draft a restart left `creating` after the tracker had made it is retried: the draft's id is the ticket's, so the retry makes no second one.
  const restarted = board();
  restarted.deps.store.set(changeDraft(restarted.queue(), "w1", "d1", (draft) => ({ ...draft, status: "creating" })));
  await approveDraft(restarted.deps, { run: "w1", draft: "d1" });
  restarted.deps.store.set(changeDraft(restarted.queue(), "w1", "d1", (draft) => ({ ...draft, status: "creating", created: undefined })));
  const retried = await approveDraft(restarted.deps, { run: "w1", draft: "d1" });
  assert.equal(restarted.created.length, 2, "the retry asked the tracker again");
  assert.equal(new Set(restarted.created.map(({ id }) => id)).size, 1, "with the same id, so the tracker gives back the ticket it made");
  assert.equal(retried.key, "NBF-101", "and the board records that one ticket");
});

test("approve and queue puts the created ticket on the queue, planned first when the page asks; a plain approve queues nothing", async () => {
  const plain = board();
  await approveDraft(plain.deps, { run: "w1", draft: "d1" });
  assert.deepEqual(plain.queued, [], "a plain approve queues nothing");
  const queuing = board();
  const made = await approveDraft(queuing.deps, { run: "w1", draft: "d1", queue: true, plan: true });
  assert.deepEqual(queuing.queued, [{ key: "NBF-101", plan: true }]);
  assert.deepEqual([made.queued, made.queueError], [true, null]);
});

test("a ticket that cannot be queued stays created, and the board says why it is not queued", async () => {
  const { deps, record } = board();
  const refusing = { ...deps, queueTicket: () => { throw new Error("a parent is never queued itself"); } };
  const made = await approveDraft(refusing, { run: "w1", draft: "d1", queue: true });
  assert.deepEqual([made.queued, made.queueError], [false, "a parent is never queued itself"]);
  assert.equal(record("d1").status, "created", "created, and not created again to queue it");
});

test("a discard creates nothing, and a created draft cannot be discarded", async () => {
  const { deps, created, record } = board();
  discardDraft(deps, { run: "w1", draft: "d1" });
  assert.equal(record("d1").status, "discarded");
  assert.equal(created.length, 0, "POSITIVE CONTROL: the discard called nothing in the tracker");
  await assert.rejects(approveDraft(deps, { run: "w1", draft: "d1" }), /was discarded, so it creates nothing/);
  const other = board();
  await approveDraft(other.deps, { run: "w1", draft: "d1" });
  assert.throws(() => discardDraft(other.deps, { run: "w1", draft: "d1" }), /is created already as NBF-101/);
});

test("the edited fields are checked by the draft format's own rules, and a bad one is refused by name", async () => {
  const { deps, created } = board();
  await assert.rejects(approveDraft(deps, { run: "w1", draft: "d1", fields: { ...good, priority: "hi" } }), /"priority" must be one of urgent, high, medium, low, none, not "hi"/);
  assert.equal(created.length, 0);
});

test("a tracker that cannot create a ticket refuses, and the draft is kept", async () => {
  const { deps, record } = board({ createTicket: false });
  await assert.rejects(approveDraft(deps, { run: "w1", draft: "d1" }), /cannot create a ticket, so nothing was created/);
  assert.equal(record("d1").status, "pending");
});

test("a relation the tracker could not make is a warning on the draft, and the ticket is still created", async () => {
  const { deps, record } = board({ warnings: ["NBF-101 was created, but it did not block A11-3"] });
  await approveDraft(deps, { run: "w1", draft: "d1" });
  assert.deepEqual(record("d1").warnings, ["NBF-101 was created, but it did not block A11-3"]);
});

test("a created ticket is in the Pick view when the list is the key's own, or the team or project the Pick view names", () => {
  assert.equal(inPickScope("assigned", { team: "NBF", project: null }), true);
  assert.equal(inPickScope({ team: "NBF" }, { team: "A11", project: null }), false);
  assert.equal(inPickScope({ project: "Visual" }, { team: "NBF", project: "Visual" }), true);
});

test("a draft a person edits is the one created, and it is kept on the draft for the review", async () => {
  const { deps, created, record } = board();
  await approveDraft(deps, { run: "w1", draft: "d1", fields: { ...good, title: "feat: an edited title" } });
  assert.equal(created[0].title, "feat: an edited title");
  assert.equal(record("d1").draft.title, "feat: an edited title");
  assert.equal(writerOf(deps.store.get(), "w1")?.drafts[0].status, "created");
});
