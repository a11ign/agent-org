// no-token: gh -- Linear and the pool are injected; the one server listens on 127.0.0.1 for the length of a test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { claimantOf, parseTicketSettings } from "./settings.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { markPublishRunning, markPublishStarting, respond as respondQueued } from "./queue/queue-transitions.ts";
import { markWriterRunning, markWriterStarting, queueWriter, writerFailed } from "./queue.ts";
import { dismiss as dismissRun, remove as removeQueued } from "./queue/queue-entries-and-outcomes.ts";
import { refusal } from "./local-http.ts";
import { checkGhWrapperAtStart, createBoard, FEEDBACK_MS, holdsKey, startFeedbackSweeps, type BoardDeps } from "./server.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { createFakeExposure } from "../plugins/fakes/exposure.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { View } from "./settings-view.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

const ticket = (key: string, title = key) => ({ key, title, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const KEY = "a".repeat(48);

function board(port = 4747, ticketSettings: Record<string, unknown> = {}, extra: Partial<BoardDeps> = {}, tracker?: TicketSource) {
  const dir = tmpDir("ticket-server-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox", "platform-monorepo": "/r/pm" }, stateDir: dir, tickets: { port, ...ticketSettings } });
  const source: TicketSource = tracker ?? createFakeTracker([ticket("NBF-1"), ticket("NBF-2"), { ...ticket("VE-9"), statusType: "completed" }]);
  const ticks: string[] = [];
  const held: { now: { name: string; reason: string; since: number } | null } = { now: null };
  const pool = {
    held: () => held.now,
    tick: async () => { ticks.push("tick"); }, stop: (key: string) => { ticks.push(`stop ${key}`); }, close: (key: string) => { ticks.push(`close ${key}`); },
    dismiss: async (key: string) => { ticks.push(`dismiss ${key}`); },
    applyEdit: async (key: string) => { ticks.push(`apply-edit ${key}`); },
    discardEdit: (key: string) => { ticks.push(`discard-edit ${key}`); },
    // The pool takes Respond, closing a parked run's workspace first: here only the queue's part, which can refuse.
    respond: (key: string) => { ticks.push(`respond ${key}`); made.store.set(respondQueued(made.store.get(), key, 7)); },
    stopWriterRun: (id: string) => { ticks.push(`stop-writer ${id}`); },
    // The pool takes a queued run off, after putting its ticket back: here only the queue's part, which the board's store is asked for.
    remove: async (key: string) => { ticks.push(`remove ${key}`); made.store.set(removeQueued(made.store.get(), key)); },
    reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, reviewNewHeads: () => {},
  };
  const made = createBoard({ settings, source, codeHost: createFakeCodeHost(), key: KEY, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7, ...extra });
  return { ...made, ticks, dir, settings, hold: (now: typeof held.now) => { held.now = now; } };
}

/** Queues NBF-1 on board `b`, then sets its run finished with `outcome`. */
async function queueFinished(b: ReturnType<typeof board>, outcome: Outcome): Promise<void> {
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" });
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, phase: "finished" as const, outcome })) });
}

test("/api/parents reads the parents of the person's tickets that are not the person's own, and leaves out one it cannot read", async () => {
  const dir = tmpDir("ticket-server-parents-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir });
  const reads: string[] = [];
  const child = (key: string, parent: string | null) => ({ ...ticket(key), parent });
  const source: TicketSource = {
    assigned: async () => [child("VE-65", "NBF-1917"), child("NBF-1936", "NBF-1917"), child("NBF-1", null), child("NBF-2", "NBF-1"), child("VAL-11", "NBF-404"), child("X-1", "NBF-500")],
    read: async (key) => {
      reads.push(key);
      if (key === "NBF-500") throw new Error("Linear answered 500");
      return key === "NBF-1917" ? child("NBF-1917", null) : null;
    },
    download: async () => [],
  };
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: () => {} };
  const { api } = createBoard({ settings, source, codeHost: createFakeCodeHost(), key: KEY, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7 });
  await api("GET", "/api/tickets", {});
  const [status, parents] = await api("GET", "/api/parents", {}) as [number, Ticket[]];
  assert.equal(status, 200);
  assert.deepEqual(parents.map((p) => p.key), ["NBF-1917"]);
  assert.deepEqual(reads, ["NBF-1917", "NBF-404", "NBF-500"], "each missing parent once, and never NBF-1, which is the person's own");
});

test("a request to another host is refused, and so is a write from another origin", () => {
  assert.equal(refusal({ headers: { host: "127.0.0.1:4747" }, method: "GET" }, 4747), null);
  assert.equal(refusal({ headers: { host: "localhost:4747" }, method: "POST", origin: undefined } as any, 4747), null);
  assert.match(String(refusal({ headers: { host: "evil.example:4747" }, method: "GET" }, 4747)), /own host/, "a DNS-rebound name is refused");
  assert.match(String(refusal({ headers: { host: "127.0.0.1:4747", origin: "https://evil.example" }, method: "POST" }, 4747)), /another origin/);
  assert.equal(refusal({ headers: { host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747" }, method: "POST" }, 4747), null);
});

test("queueing takes the tickets you selected with the model and effort sent, no repository until the worker chooses one, and wakes the pool", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  const [status, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-2", "VE-9"], model: "opus", effort: "max" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(queue.entries.map((e: any) => [e.ticket.key, e.repos, e.model, e.effort]), [
    ["NBF-2", [], "opus", "max"],
    ["VE-9", [], "opus", "max"],
  ], "VE-9 was not in the assigned list, so it was read by key");
  assert.ok(existsSync(join(b.dir, "queue.json")));
  assert.deepEqual(b.ticks, ["tick"]);
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.choice, { model: "opus", effort: "high", planModel: "opus", planEffort: "high" }, "the settings decide new runs; queueing does not change them");
});

test("the settings save the part of the choice they name, keep the other part, refuse an unknown or empty change, and wake nothing", async () => {
  const b = board();
  const [, model] = await b.api("POST", "/api/choice", { model: "sonnet" }) as [number, any];
  assert.deepEqual(model, { choice: { model: "sonnet", effort: "high", planModel: "opus", planEffort: "high" } });
  const [, effort] = await b.api("POST", "/api/choice", { effort: "max" }) as [number, any];
  assert.deepEqual(effort, { choice: { model: "sonnet", effort: "max", planModel: "opus", planEffort: "high" } }, "a change to the effort keeps the model saved before it");
  await assert.rejects(b.api("POST", "/api/choice", { model: "gpt" }), /model must be one of/);
  await assert.rejects(b.api("POST", "/api/choice", { effort: "huge" }), /effort must be one of/);
  await assert.rejects(b.api("POST", "/api/choice", {}), /name a model or an effort/);
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.choice, { model: "sonnet", effort: "max", planModel: "opus", planEffort: "high" });
  assert.deepEqual(b.ticks, [], "a setting for new runs wakes nothing");
});

test("a saved model or effort the board no longer offers falls back, so queueing with the settings is never refused", async () => {
  const b = board();
  writeFileSync(join(b.dir, "choice.json"), JSON.stringify({ model: "gpt-9", effort: "max", planModel: "sonnet", planEffort: "huge" }));
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.choice, { model: "opus", effort: "max", planModel: "sonnet", planEffort: "high" });
});

test("planning has its own model and effort in the settings, opus at high until changed, and changing it leaves the run's alone", async () => {
  const b = board();
  const [, before] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual([before.choice.planModel, before.choice.planEffort], ["opus", "high"]);
  await b.api("POST", "/api/choice", { model: "sonnet" });
  const [, saved] = await b.api("POST", "/api/choice", { planEffort: "max" }) as [number, any];
  assert.deepEqual(saved.choice, { model: "sonnet", effort: "high", planModel: "opus", planEffort: "max" });
  await assert.rejects(b.api("POST", "/api/choice", { planModel: "gpt" }), /model must be one of/);
});

/** A board whose machine plans, over a tracker that takes plans: NBF-1 has a plan of its own and NBF-2 has none. */
function planningBoard(attachPlan: TicketSource["attachPlan"] | null = async () => null, run = "plan {key} into {dir}") {
  const dir = tmpDir("ticket-server-planning-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir,
    tickets: { plan: "-plan-[^/]*\\.md$", planner: { run, state: "Planned" } } });
  const planned = { ...ticket("NBF-1"), uploads: ["NBF-1-0001-plan-x.md"] };
  const source: TicketSource = { assigned: async () => [planned, ticket("NBF-2"), ticket("NBF-3")], read: async () => null, download: async () => [], ...(attachPlan ? { attachPlan } : {}) };
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: () => {} };
  return createBoard({ settings, source, codeHost: createFakeCodeHost(), key: KEY, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7 });
}

test("queueing with plan first plans each ticket without a plan of its own, on the planning model and effort, and leaves the others to be worked", async () => {
  const b = planningBoard();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/choice", { planModel: "opus", planEffort: "max" });
  const [, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-1", "NBF-2"], model: "sonnet", effort: "high", plan: true }) as [number, any];
  assert.deepEqual(queue.entries.map((e: any) => [e.ticket.key, e.model, e.plan ?? null]), [["NBF-1", "sonnet", null], ["NBF-2", "sonnet", { model: "opus", effort: "max" }]]);
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.equal(config.planner, true, "the page is told this board plans");
});

test("the tickets one press of Queue plans first are one batch when the planner names {keys}, and each is planned alone when it names only {key}", async () => {
  for (const [run, batches] of [["plan {keys} into {dir}", ["b7-0", "b7-0"]], ["plan {key} into {dir}", [null, null]]] as const) {
    const b = planningBoard(async () => null, run);
    await b.api("GET", "/api/tickets", {});
    const [, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-1", "NBF-2", "NBF-3"], model: "sonnet", effort: "high", plan: true }) as [number, any];
    assert.deepEqual(queue.entries.slice(1).map((e: any) => e.batch ?? null), batches, run);
    assert.equal(queue.entries[0].batch, undefined, "a ticket with a plan of its own is in no batch");
  }
});

/** A tracker of the tickets given, with another instance's claim (`desk.99999999`) on each key `claimed` names. */
function trackerClaimedBy(claimed: readonly string[], tickets: readonly Ticket[]) {
  const tracker = createFakeTracker(tickets);
  for (const key of claimed) tracker.setClaimant(key, "desk.99999999");
  return tracker;
}

/** Queues NBF-1 on board `b`: the answer's status, and its refusal's sentence, when it has one. */
async function queueNbf1(b: ReturnType<typeof board>): Promise<[number, string | undefined]> {
  const [status, answer] = await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }) as [number, any];
  return [status, answer.error];
}

/** The tickets the page lists on board `b`, each with `taken` where another instance holds it. */
async function listedTickets(b: ReturnType<typeof board>): Promise<any[]> {
  const [, listed] = await b.api("GET", "/api/tickets", {}) as [number, any[]];
  return listed;
}

const inProgress = (key: string) => ({ ...ticket(key), status: "In Progress", statusType: "started" }) as Ticket;

test("A11-144: a ticket another instance holds is marked taken in the list, and queueing it is refused with 409 naming its state and the claimant", async () => {
  const tracker = trackerClaimedBy(["NBF-1"], [inProgress("NBF-1"), ticket("NBF-2")]);
  const b = board(4747, {}, {}, tracker);
  const [, listed] = await b.api("GET", "/api/tickets", {}) as [number, any];
  assert.equal(listed.find((t: any) => t.key === "NBF-1").taken, "In Progress");
  assert.equal(listed.find((t: any) => t.key === "NBF-2").taken, undefined, "a ticket no state marks is not taken");
  const [status, refused] = await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(status, 409);
  assert.equal(refused.error, "NBF-1 is In Progress in the tracker and desk.99999999 claimed it, so another instance holds it");
  const [queuedStatus] = await b.api("POST", "/api/queue", { keys: ["NBF-2"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(queuedStatus, 200, "a ticket that is not taken queues as before");
});

test("A11-144: a state the team's takenStates names marks its claimed tickets taken, even without the started type", async () => {
  const planned = { ...ticket("NBF-2"), status: "Planned" } as Ticket;
  const tracker = trackerClaimedBy(["NBF-2"], [planned]);
  const b = board(4747, { providers: { tracker: { provider: "linear", takenStates: ["Planned"] } } }, {}, tracker);
  const [, listed] = await b.api("GET", "/api/tickets", {}) as [number, any];
  assert.equal(listed[0].taken, "Planned");
  const other = board(4747, { providers: { tracker: { provider: "linear", takenStates: [] } } }, {}, tracker);
  const [, unlisted] = await other.api("GET", "/api/tickets", {}) as [number, any];
  assert.equal(unlisted[0].taken, undefined, "an empty list takes no state that is not started");
});

test("A11-144: a ticket this instance holds a run for is not marked taken, though the tracker now shows it In Progress under another instance's claim", async () => {
  const tracker = createFakeTracker([ticket("NBF-1")]);
  const b = board(4747, {}, {}, tracker);
  await b.api("GET", "/api/tickets", {});
  const [queued] = await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(queued, 200);
  tracker.seed({ ...tracker.ticketOf("NBF-1")!, status: "In Progress", statusType: "started" });
  tracker.setClaimant("NBF-1", "desk.99999999");
  const [, listed] = await b.api("GET", "/api/tickets", {}) as [number, any];
  assert.equal(listed[0].taken, undefined, "this instance's own run holds it");
});

test("A11-168: a ticket In Progress from this instance's own dismissed run, claimed by this instance, is listed free and is queued", async () => {
  const tracker = createFakeTracker([inProgress("NBF-1")]);
  const b = board(4747, {}, {}, tracker);
  tracker.setClaimant("NBF-1", claimantOf(b.settings));
  const [, listed] = await b.api("GET", "/api/tickets", {}) as [number, any];
  assert.equal(listed[0].taken, undefined, "its latest claim names this instance");
  const [status, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(queue.entries.map((e: any) => e.ticket.key), ["NBF-1"]);
});

test("A11-173: a stopped partial run on a plan with no remaining step is dismissed and its In Progress ticket, claimed by this instance, is queued again with no state move", async () => {
  const tracker = createFakeTracker([inProgress("NBF-1")]);
  const b = board(4747, {}, {}, tracker);
  tracker.setClaimant("NBF-1", claimantOf(b.settings));
  const url = "https://github.com/a11ign/agent-org/pull/1816";
  await queueFinished(b, { kind: "ready-pr", prs: [{ repo: "agent-org", url }], partial: "the docs" });
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, pullStates: { [url]: "merged" as const }, partial: "the docs", planSteps: 0 })) });
  assert.equal(runStatus(b.store.get().entries[0]), "needs-you", "the plan has no remaining step, so the run stops for a person");
  b.store.set(dismissRun(b.store.get(), "NBF-1"));
  assert.deepEqual(b.store.get().entries, [], "Dismiss takes it off the board");
  const before = tracker.ticketOf("NBF-1");
  const [status, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(status, 200, "queued again with no one moving the ticket in the tracker");
  assert.deepEqual(queue.entries.map((e: any) => [e.ticket.key, e.phase]), [["NBF-1", "queued"]]);
  assert.deepEqual(tracker.ticketOf("NBF-1"), before, "and the ticket is in the state it was in");
});

test("A11-168: a ticket In Progress with no claim at all, moved there by hand, is not taken and is queued", async () => {
  const b = board(4747, {}, {}, createFakeTracker([inProgress("NBF-1")]));
  const [, listed] = await b.api("GET", "/api/tickets", {}) as [number, any];
  assert.equal(listed[0].taken, undefined);
  const [status] = await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(status, 200);
});

test("A11-168: a ticket the list read as In Progress under another's claim, moved to Todo since, is read again and queued", async () => {
  const tracker = trackerClaimedBy(["NBF-1"], [inProgress("NBF-1")]);
  const b = board(4747, {}, {}, tracker);
  const [, listed] = await b.api("GET", "/api/tickets", {}) as [number, any];
  assert.equal(listed[0].taken, "In Progress");
  tracker.seed({ ...ticket("NBF-1") });
  const [status, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(status, 200, "the tracker says Todo now, so the page's old copy does not refuse it");
  assert.deepEqual(queue.entries.map((e: any) => [e.ticket.key, e.ticket.status]), [["NBF-1", "Backlog"]], "and the entry holds the fresh copy");
});

test("A11-168: a ticket the list read as claimed by another instance, claimed by this one since, is read again and queued", async () => {
  const tracker = trackerClaimedBy(["NBF-1"], [inProgress("NBF-1")]);
  const b = board(4747, {}, {}, tracker);
  await b.api("GET", "/api/tickets", {});
  tracker.setClaimant("NBF-1", claimantOf(b.settings));
  const [status] = await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(status, 200);
});

test("A11-168: a tracker that cannot be asked who holds a ticket answers 503 naming why, never taken, and a list whose claims cannot be read marks nothing taken", async () => {
  const tracker = trackerClaimedBy(["NBF-1"], [inProgress("NBF-1")]);
  const b = board(4747, {}, {}, tracker);
  assert.equal((await listedTickets(b))[0].taken, "In Progress");
  tracker.claims = async () => { throw new Error("Linear answered 502"); };
  assert.deepEqual(await queueNbf1(b), [503, "could not ask the tracker who holds NBF-1: Linear answered 502"]);
  assert.deepEqual(b.store.get().entries, [], "nothing was queued");
  assert.equal((await listedTickets(b))[0].taken, undefined, "a claim that could not be read is not another instance's");
  assert.deepEqual(await queueNbf1(b), [503, "could not ask the tracker who holds NBF-1: Linear answered 502"], "and the queue does not take the empty answer for a free ticket: it asks again, and says it could not");
});

test("A11-168: a ticket in work the list never read a claim for is read again before it is queued, and one the tracker has none of is not a 503", async () => {
  const tracker = trackerClaimedBy(["NBF-1"], [inProgress("NBF-1")]);
  const b = board(4747, {}, {}, tracker);
  assert.deepEqual(await queueNbf1(b), [409, "NBF-1 is In Progress in the tracker and desk.99999999 claimed it, so another instance holds it"], "no list was read, so the board's copy knew nothing");
  const vanishing: TicketSource = { assigned: async () => [inProgress("NBF-1")], read: async () => null, download: async () => [] };
  const gone = board(4747, {}, {}, vanishing);
  await listedTickets(gone);
  await assert.rejects(gone.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" }), /no ticket NBF-1/);
});

test("A11-168: a tracker whose ticket read fails answers 503 too, and a tracker with no claims takes no ticket", async () => {
  const tracker = trackerClaimedBy(["NBF-1"], [inProgress("NBF-1")]);
  const b = board(4747, {}, {}, tracker);
  await b.api("GET", "/api/tickets", {});
  tracker.read = async () => { throw new Error("Linear is down"); };
  assert.deepEqual(await queueNbf1(b), [503, "could not ask the tracker who holds NBF-1: Linear is down"]);
  const bare: TicketSource = { assigned: async () => [inProgress("NBF-2")], read: async () => inProgress("NBF-2"), download: async () => [] };
  const c = board(4747, {}, {}, bare);
  const [, listed] = await c.api("GET", "/api/tickets", {}) as [number, any];
  assert.equal(listed[0].taken, undefined, "a source that cannot name a claimant takes nothing");
});

test("queueing without plan first, or on a board that does not plan, plans nothing", async () => {
  const b = planningBoard();
  await b.api("GET", "/api/tickets", {});
  const [, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-2"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(queue.entries[0].plan, undefined);
  const plain = board();
  await plain.api("GET", "/api/tickets", {});
  const [, unplanned] = await plain.api("POST", "/api/queue", { keys: ["NBF-2"], model: "opus", effort: "high", plan: true }) as [number, any];
  assert.equal(unplanned.entries[0].plan, undefined, "a machine with no planner plans nothing, whatever the page asks");
  const [, config] = await plain.api("GET", "/api/config", {}) as [number, any];
  assert.equal(config.planner, false);
  const noAttach = planningBoard(null);
  const [, told] = await noAttach.api("GET", "/api/config", {}) as [number, any];
  assert.equal(told.planner, false, "a tracker that cannot take a plan is not offered planning");
});

test("an unknown model or an unknown ticket is refused, and nothing is queued", async () => {
  const b = board();
  await assert.rejects(b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "gpt", effort: "high" }), /model must be one of/);
  await assert.rejects(b.api("POST", "/api/queue", { keys: ["NOPE-1"], model: "opus", effort: "high" }), /no ticket NOPE-1/);
  assert.deepEqual(b.store.get().entries, []);
});

test("an amend is held to the rules queueing uses: an unknown model or effort is refused and the entry is unchanged", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "opus", effort: "high" });
  const before = JSON.stringify(b.store.get());
  await assert.rejects(b.api("POST", "/api/queue/NBF-1/amend", { model: "gpt" }), /model must be one of/);
  await assert.rejects(b.api("POST", "/api/queue/NBF-1/amend", { effort: "extreme" }), /effort must be one of/);
  assert.equal(JSON.stringify(b.store.get()), before);
  await b.api("POST", "/api/queue/NBF-1/amend", { model: "sonnet" });
  assert.deepEqual(b.store.get().entries.map((e) => [e.model, e.effort]), [["sonnet", "high"]]);
});

test("the board's queue starts paused, and Start and Pause go through the API", async () => {
  const b = board();
  const [, queue] = await b.api("GET", "/api/queue", {}) as [number, any];
  assert.equal(queue.paused, true);
  await b.api("POST", "/api/paused", { paused: false });
  assert.equal(b.store.get().paused, false);
  assert.deepEqual(b.ticks, ["tick"], "starting wakes the pool");
  await assert.rejects(b.api("POST", "/api/paused", { paused: "no" }), /true or false/);
  await b.api("POST", "/api/paused", { paused: true });
  assert.equal(b.store.get().paused, true);
});

test("approve queues a finished run's draft pull requests again as a review run", async () => {
  const b = board();
  const pr = { repo: "app", url: "https://github.com/x/app/pull/1" };
  await queueFinished(b, { kind: "draft-pr", prs: [pr] });
  await b.api("POST", "/api/queue/NBF-1/approve", {});
  const [entry] = b.store.get().entries;
  assert.deepEqual([entry.phase, entry.review], ["queued", [pr]]);
  assert.ok(b.ticks.includes("tick"), "approving wakes the pool");
});

const READY_PR = { repo: "app", url: "https://github.com/x/app/pull/1" };

test("Respond to review queues a review round of a run whose pull requests are ready, through the board", async () => {
  const b = board();
  await queueFinished(b, { kind: "reviewed", prs: [READY_PR] });
  await b.api("POST", "/api/queue/NBF-1/respond", {});
  const [entry] = b.store.get().entries;
  assert.deepEqual([entry.phase, entry.review, entry.asked], ["queued", [READY_PR], true]);
  assert.ok(b.ticks.includes("tick"), "responding wakes the pool");
});

test("A11-154: Respond to review goes through the pool: a run that ended needs-human with a pull request open gets its round, and a press that cannot act answers why", async () => {
  const b = board();
  await queueFinished(b, { kind: "needs-human", reason: "which colour?" });
  const before = b.ticks.length;
  const press = () => b.api("POST", "/api/queue/NBF-1/respond", {});
  await assert.rejects(press(), /NBF-1 has no pull request open, so there is no feedback to answer/, "the refusal reaches the response");
  assert.deepEqual(b.ticks.slice(before), ["respond NBF-1"], "the pool was asked, and nothing was woken for a refusal");
  assert.equal(b.store.get().entries[0].phase, "finished");
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, review: [READY_PR], pullStates: { [READY_PR.url]: "open" } })) });
  await press();
  const [entry] = b.store.get().entries;
  assert.deepEqual([entry.phase, entry.review, entry.asked], ["queued", [READY_PR], true]);
  assert.ok(b.ticks.includes("tick"), "responding wakes the pool");
  await assert.rejects(press(), /a round is already queued for NBF-1/, "a second press says a round is queued");
});

// A11-125: Start anyway, through the board, passes a queued run's overlap, records it, logs it and wakes the pool; a refusal is named.
test("A11-125: Start anyway, through the board, records the overlap it passes and wakes the pool, and refuses a run that overlaps nothing", async () => {
  const b = board();
  const holder = { ticket: { key: "NBF-1", title: "t", url: "" }, repos: [], model: "opus", effort: "high", queuedAt: 1, phase: "running", paths: ["nbl-ui-netbox:src/pool.ts"] };
  const waiting = { ...holder, ticket: { key: "NBF-2", title: "t", url: "" }, phase: "queued", paths: ["nbl-ui-netbox:src/"] };
  const free = { ...holder, ticket: { key: "NBF-3", title: "t", url: "" }, phase: "queued", paths: ["nbl-ui-netbox:docs/"] };
  b.store.set({ ...b.store.get(), entries: [holder, waiting, free] as never });
  await assert.rejects(b.api("POST", "/api/queue/NBF-3/start-anyway", {}), /nothing overlaps NBF-3 now, so there is no overlap to start past/);
  assert.equal(b.ticks.length, 0, "a refusal wakes nothing");
  await b.api("POST", "/api/queue/NBF-2/start-anyway", {});
  const [, passed] = b.store.get().entries;
  assert.deepEqual([passed.overlapOverride?.holder, passed.overlapOverride?.path], ["NBF-1", "src/"], "the overlap it passed is recorded on the run");
  assert.ok(b.ticks.includes("tick"), "starting anyway wakes the pool");
});

test("Publish queues one publish run for the ticked runs Ready to merge on a machine that publishes, and is refused on one that does not", async () => {
  const run = "Post {prs}, then write {dir}/published.json";
  for (const [publish, expected] of [[{ run }, true], [undefined, false]] as const) {
    const b = board(4747, publish ? { publish } : {});
    const [, config] = await b.api("GET", "/api/config", {}) as [number, { publish: boolean }];
    assert.equal(config.publish, expected);
    const pr = { repo: "app", url: "https://github.com/x/app/pull/1" };
    await queueFinished(b, { kind: "reviewed", prs: [pr] });
    if (!expected) {
      await assert.rejects(b.api("POST", "/api/publish", { keys: ["NBF-1"] }), /names no tickets.publish/);
      continue;
    }
    await b.api("POST", "/api/publish", { keys: ["NBF-1"] });
    assert.deepEqual([b.store.get().publish?.keys, b.store.get().publish?.prs], [["NBF-1"], [pr]]);
    assert.ok(b.ticks.includes("tick"), "publishing wakes the pool");
    await assert.rejects(b.api("POST", "/api/publish", { keys: ["NBF-1"] }), /a publish run is under way/);
  }
});

test("A11-161: /api/config says whether the publisher is on, off (installed and switched off) or none, and the reviewer is on, off-required or none; with no publisher Publish is refused", async () => {
  const publishing = { run: "Post {prs}, then write {dir}/published.json", connectors: ["^mcp__chat__send"] };
  const states = async (tickets: Record<string, unknown>) => {
    const b = board(4747, tickets);
    const [, config] = await b.api("GET", "/api/config", {}) as [number, { publish: boolean; publisher: string; reviewer: string }];
    return { b, said: [config.publish, config.publisher, config.reviewer] };
  };
  assert.deepEqual((await states({})).said, [false, "none", "none"], "no publisher and no reviewer: nothing extra is said");
  assert.deepEqual((await states({ providers: { publish: { provider: "slack", ...publishing } } })).said, [true, "on", "none"]);
  const off = await states({ providers: { publish: { provider: "slack", enabled: false, ...publishing } } });
  assert.deepEqual(off.said, [false, "off", "none"], "installed and switched off: the Publish buttons are hidden, and the page says publishing is off");
  await queueFinished(off.b, { kind: "reviewed", prs: [{ repo: "app", url: "https://github.com/x/app/pull/1" }] });
  await assert.rejects(off.b.api("POST", "/api/publish", { keys: ["NBF-1"] }), /names no tickets.publish/, "and nothing can be queued to publish");
  assert.deepEqual((await states({ providers: { reviewer: { provider: "atomic" } } })).said, [false, "none", "on"]);
  assert.deepEqual((await states({ providers: { reviewer: { provider: "atomic", enabled: false } } })).said, [false, "none", "off-required"], "required, since the block names a reviewer plugin: the banner is the page's");
  assert.deepEqual((await states({ providers: { reviewer: { provider: "atomic", enabled: false, required: false } } })).said, [false, "none", "none"], "not required: people review here, and nothing extra is said");
  assert.deepEqual((await states({ providers: { reviewer: { provider: "none", required: true } } })).said, [false, "none", "off-required"]);
});

test("the queue the page reads carries the running publish run's workspace and pane, so each run it posts can link its terminal", async () => {
  const b = board(4747, { publish: { run: "Post {prs}, then write {dir}/published.json" } });
  const pr = { repo: "app", url: "https://github.com/x/app/pull/1" };
  await queueFinished(b, { kind: "reviewed", prs: [pr] });
  await b.api("POST", "/api/publish", { keys: ["NBF-1"] });
  const read = async () => (await b.api("GET", "/api/queue", {}) as [number, { publish: { phase: string; workspace?: string; pane?: string } }])[1].publish;
  const queued = await read();
  assert.deepEqual([queued.phase, queued.workspace, queued.pane], ["queued", undefined, undefined], "queued, it has no pane yet");
  b.store.set(markPublishRunning(markPublishStarting(b.store.get(), 8), "w9", "w9:p1"));
  const running = await read();
  assert.deepEqual([running.phase, running.workspace, running.pane], ["running", "w9", "w9:p1"]);
});

test("remove, stop, close, dismiss and max go through the board", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1", "NBF-2"], model: "sonnet", effort: "high" });
  await b.api("POST", "/api/queue/NBF-1/remove", {});
  await b.api("POST", "/api/queue/NBF-2/stop", {});
  await b.api("POST", "/api/queue/NBF-2/close", {});
  await b.api("POST", "/api/queue/NBF-2/dismiss", {});
  await b.api("POST", "/api/max", { max: 5 });
  assert.deepEqual(b.store.get().entries.map((e) => e.ticket.key), ["NBF-2"]);
  assert.ok(b.ticks.includes("remove NBF-1"), "Remove is the pool's, which puts a queued run's ticket back before the run leaves the queue");
  assert.ok(b.ticks.includes("stop NBF-2"));
  assert.ok(b.ticks.includes("close NBF-2"), "a parked run's workspace is the pool's to close");
  assert.ok(b.ticks.includes("dismiss NBF-2"), "Dismiss is the pool's, which closes a parked run's workspace before the run leaves the board");
  assert.equal(b.store.get().max, 5);
});

test("A11-91: Apply and Discard edit go through the pool, and only as a person's POST", async () => {
  const b = board();
  await b.api("POST", "/api/queue/NBF-1/apply-edit", {});
  await b.api("POST", "/api/queue/NBF-1/discard-edit", {});
  assert.deepEqual(b.ticks.filter((tick) => tick !== "tick"), ["apply-edit NBF-1", "discard-edit NBF-1"], "the pool applies and discards, in the order asked");
});

test("the page is given the machine's terminal address, or null when it serves none", async () => {
  const [, config] = await board().api("GET", "/api/config", {}) as [number, any];
  assert.equal(config.terminal, null);
});

test("the page is given the pattern a ticket's plan is named by, or null when the machine names none", async () => {
  const [, none] = await board().api("GET", "/api/config", {}) as [number, any];
  assert.equal(none.plan, null);
  const [, named] = await board(4747, { plan: "-plan-[^/]*\\.md$" }).api("GET", "/api/config", {}) as [number, any];
  assert.equal(named.plan, "-plan-[^/]*\\.md$");
});

/** A port on 127.0.0.1 that nothing listens on: one a probe server had, and gave back. */
async function freePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** A board listening on a free port on 127.0.0.1, for `run`, then closed. */
async function overHttp(run: (base: string) => Promise<void>, extra: Partial<BoardDeps> = {}) {
  const port = await freePort();
  const b = board(port, {}, extra);
  const server = createServer((req, res) => { void b.handle(req, res); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}
const keyed = { "x-ticket-token": KEY };

test("over HTTP: the instance serves no page and no pairing: a request without its key is refused, and with it the page's paths are not found", async () => {
  await overHttp(async (base) => {
    for (const path of ["/", "/board-view.js", "/api/queue"]) {
      const refused = await fetch(`${base}${path}`);
      assert.equal(refused.status, 401, path);
      assert.equal(refused.headers.get("content-type"), "application/json");
      assert.match((await refused.json() as { error: string }).error, /an agent-org instance, which serves no page and answers only to its key: open the board with agent-org ticket:ui/);
    }
    for (const [method, path] of [["GET", "/"], ["GET", "/board-view.js"], ["POST", "/api/pair-code"], ["POST", "/pair"], ["GET", "/api/connections"]]) {
      const answer = await fetch(`${base}${path}`, { method, headers: keyed });
      assert.equal(answer.status, 404, `${method} ${path}`);
      assert.equal(answer.headers.get("content-type"), "application/json");
    }
    assert.equal((await fetch(`${base}/api/queue`, { headers: keyed })).status, 200);
  });
});

test("over HTTP: a browser's session cookie opens nothing on the instance", async () => {
  await overHttp(async (base) => {
    assert.equal((await fetch(`${base}/api/queue`, { headers: { cookie: `ticket_session=${"s".repeat(48)}` } })).status, 401);
    assert.equal((await fetch(`${base}/api/queue`, { headers: { cookie: `ticket_session=${KEY}` } })).status, 401, "not even the key as a cookie");
  });
});

test("the instance is paired by its key in the header alone, compared whole", () => {
  assert.equal(holdsKey({ headers: { "x-ticket-token": KEY } }, KEY), true);
  assert.equal(holdsKey({ headers: { "x-ticket-token": "wrong" } }, KEY), false);
  assert.equal(holdsKey({ headers: { "x-ticket-token": `${"a".repeat(47)}\u00e9` } }, KEY), false, "a header of the key's length but more bytes is refused, not thrown");
  assert.equal(holdsKey({ headers: {} }, KEY), false);
});

test("over HTTP: a body that is not JSON is a 400, and the instance keeps answering", async () => {
  await overHttp(async (base) => {
    const bad = await fetch(`${base}/api/paused`, { method: "POST", headers: keyed, body: "{" });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/queue`, { headers: keyed })).status, 200);
  });
});

test("over HTTP: a request body over 64 KB is refused, even with the key", async () => {
  await overHttp(async (base) => {
    const big = await fetch(`${base}/api/queue`, { method: "POST", headers: keyed, body: JSON.stringify({ keys: ["x".repeat(70_000)] }) });
    assert.equal(big.status, 400);
    assert.match((await big.json() as { error: string }).error, /over 65536 bytes/);
  });
});

test("A11-69: the board says which tickets the Pick view lists, and why it is empty, naming the key's person only when it lists theirs", async () => {
  const [, config] = await board().api("GET", "/api/config", {}) as [number, { pick: string }];
  assert.equal(config.pick, "assigned to you");
  let asked = 0;
  const named = board(4747, {}, { source: { assigned: async () => [], read: async () => null, download: async () => [], viewer: async () => { asked += 1; return "Dan Beck"; } } });
  const [status, pick] = await named.api("GET", "/api/pick", {}) as [number, { empty: string }];
  assert.equal(status, 200);
  assert.match(pick.empty, /^No open tickets are assigned to Dan Beck,.*tickets\.pick/);
  const failing = board(4747, {}, { source: { assigned: async () => [], read: async () => null, download: async () => [], viewer: async () => { throw new Error("Linear answered 500"); } } });
  assert.match((await failing.api("GET", "/api/pick", {}) as [number, { empty: string }])[1].empty, /^No open tickets are assigned to you,/, "a tracker that cannot say whose key it is reads as you");
  const team = board(4747, { pick: { team: "A11" } }, { source: { assigned: async () => [], read: async () => null, download: async () => [], viewer: async () => { asked += 1; return "x"; } } });
  const [, teamConfig] = await team.api("GET", "/api/config", {}) as [number, { pick: string }];
  assert.equal(teamConfig.pick, "open in team A11");
  assert.match((await team.api("GET", "/api/pick", {}) as [number, { empty: string }])[1].empty, /^Team A11 has no open tickets/);
  assert.equal(asked, 1, "a team's list names no person, so none is asked for");
});

test("A11-108: the config names the Assignee filter's default and the key's person, read once and kept; a failed read is null and is asked again", async () => {
  let asked = 0;
  let down = true;
  const tracker: TicketSource = {
    assigned: async () => [{ ...ticket("NBF-1"), assignee: { id: "dan", name: "Dan Beck" } }, { ...ticket("NBF-2"), assignee: null }], read: async () => null, download: async () => [],
    me: async () => { asked += 1; if (down) throw new Error("Linear answered 500"); return { id: "dan", name: "Dan Beck" }; },
  };
  const b = board(4747, {}, {}, tracker);
  const [, failed] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.equal(failed.viewer, null, "a tracker that cannot say whose key it is gives null, and the page lists every ticket");
  assert.deepEqual([failed.pickDefault, failed.pickOpen], ["you", "open"]);
  down = false;
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.viewer, { id: "dan", name: "Dan Beck" });
  await b.api("GET", "/api/config", {});
  assert.equal(asked, 2, "the failed read is asked again, and the one that worked is kept");
  const [, list] = await b.api("GET", "/api/tickets", {}) as [number, any[]];
  assert.deepEqual(list.map((t) => t.assignee), [{ id: "dan", name: "Dan Beck" }, null], "each ticket carries its assignee, unassigned as null");
});

test("A11-108: a team or a project names Anyone as the default and its own words for it, and reads no person", async () => {
  const [, config] = await board(4747, { pick: { team: "A11" } }).api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual([config.pickDefault, config.pickOpen], ["anyone", "open in team A11"]);
  const [, mine] = await board().api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual([mine.pickDefault, mine.pickOpen], ["you", "open"]);
});

/** A board over a tracker with an epic, A11-24, whose open sub-issues are A11-27, A11-25 and A11-26, and an epic of epics, A11-40. */
function epicBoard(blockers: TicketSource["blockers"] | null) {
  const reads: string[] = [];
  const tickets = new Map<string, Ticket>([
    ["A11-24", { ...ticket("A11-24"), children: ["A11-27", "A11-25", "A11-26"] }],
    ["A11-25", ticket("A11-25")], ["A11-26", ticket("A11-26")], ["A11-27", ticket("A11-27")],
    ["A11-30", { ...ticket("A11-30"), children: [] }],
    ["A11-40", { ...ticket("A11-40"), children: ["A11-24", "A11-41"] }], ["A11-41", ticket("A11-41")],
  ]);
  const source: TicketSource = {
    assigned: async () => [tickets.get("A11-24")!, tickets.get("A11-25")!, tickets.get("A11-30")!],
    read: async (key) => { reads.push(key); return tickets.get(key) ?? null; },
    download: async () => [],
    ...(blockers ? { blockers } : {}),
  };
  return { ...board(4747, {}, { source }), reads };
}

test("A11-76: the queue refuses a parent with a 400 that says why, over HTTP, and queues the same ticket once its sub-issues are done", async () => {
  const b = epicBoard(null);
  await b.api("GET", "/api/tickets", {});
  await assert.rejects(b.api("POST", "/api/queue", { keys: ["A11-25", "A11-24"], model: "opus", effort: "high" }),
    /A11-24 has 3 open sub-issues \(A11-27, A11-25, A11-26\): a parent is not queued.*Queue its children instead/);
  assert.deepEqual(b.store.get().entries, [], "nothing of the request is queued, not even the ordinary ticket beside the parent");
  const [, queue] = await b.api("POST", "/api/queue", { keys: ["A11-30"], model: "opus", effort: "high" }) as [number, any];
  assert.deepEqual(queue.entries.map((e: any) => e.ticket.key), ["A11-30"], "an epic with no sub-issue open is an ordinary ticket");
  const source: TicketSource = createFakeTracker([{ ...ticket("A11-24"), children: ["A11-25"] }]);
  await overHttp(async (base) => {
    const refused = await fetch(`${base}/api/queue`, { method: "POST", headers: keyed, body: JSON.stringify({ keys: ["A11-24"], model: "opus", effort: "high" }) });
    assert.equal(refused.status, 400);
    assert.match((await refused.json() as { error: string }).error, /^A11-24 has 1 open sub-issue \(A11-25\): a parent is not queued/);
  }, { source });
});

test("A11-76: Queue its children queues a parent's open sub-issues in their blocking order, read afresh, and wakes the pool", async () => {
  const asked: string[][] = [];
  const b = epicBoard(async (keys) => {
    asked.push([...keys]);
    return new Map([["A11-25", [{ key: "A11-27", state: "started", status: "In Progress", pulls: {} }]], ["A11-26", []], ["A11-27", [{ key: "A11-26", state: "unstarted", status: "Todo", pulls: {} }]]]);
  });
  await b.api("GET", "/api/tickets", {});
  const [status, answer] = await b.api("POST", "/api/queue-children", { key: "A11-24", model: "sonnet", effort: "max" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(answer.keys, ["A11-26", "A11-27", "A11-25"]);
  assert.equal(answer.note, null, "the order is the tracker's, so nothing needs saying");
  assert.deepEqual(answer.queue.entries.map((e: any) => [e.ticket.key, e.model, e.effort]), [["A11-26", "sonnet", "max"], ["A11-27", "sonnet", "max"], ["A11-25", "sonnet", "max"]]);
  assert.deepEqual(asked, [["A11-27", "A11-25", "A11-26"]], "the blockers of every child, in one read");
  assert.deepEqual(b.reads, ["A11-24", "A11-26", "A11-27"], "the parent is read afresh, and a child the list holds (A11-25) is not read again");
  assert.deepEqual(b.ticks, ["tick"]);
});

test("A11-76: Queue its children goes by identifier where the tracker gives no order, says so, leaves out a child that is itself a parent, and refuses a ticket with none open", async () => {
  const b = epicBoard(null);
  const [, plain] = await b.api("POST", "/api/queue-children", { key: "A11-24", model: "opus", effort: "high" }) as [number, any];
  assert.deepEqual(plain.keys, ["A11-25", "A11-26", "A11-27"]);
  assert.equal(plain.note, "the tracker gives no blocking order, so they are queued in identifier order");
  const [, nested] = await b.api("POST", "/api/queue-children", { key: "A11-40", model: "opus", effort: "high" }) as [number, any];
  assert.deepEqual(nested.keys, ["A11-41"]);
  assert.match(nested.note, /A11-24 is itself a parent, so not queued: queue its children from its own row/);
  await assert.rejects(b.api("POST", "/api/queue-children", { key: "A11-30", model: "opus", effort: "high" }), /^Error: A11-30 has no open sub-issues: queue it as it is$/);
  await assert.rejects(b.api("POST", "/api/queue-children", { key: "A11-404", model: "opus", effort: "high" }), /no ticket A11-404/);
  await assert.rejects(b.api("POST", "/api/queue-children", { key: "A11-24", model: "gpt", effort: "high" }), /model must be one of/);
});

const LOOPBACK_TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const tailnetTerminalOf = (port: number) => `https://agents.tail1234.ts.net:${port}/?ws={workspace}&pane={pane}&view=terminal`;
const terminalOf = async (b: ReturnType<typeof board>) => ((await b.api("GET", "/api/config", {}))[1] as { terminal: string | null }).terminal;
/** The exposure the board is given (A11-162): a named one serves the page and the terminal on ports of its own; the default fake serves nothing. */
const exposureOf = (name: string | null, ports?: { ui: number; terminal: number }) => ({ exposure: createFakeExposure(name, ports) });

test("with an exposure that serves the terminal under a name, the page is handed its address, unless the stored one names another machine", async () => {
  assert.equal(await terminalOf(board(4747, { terminal: LOOPBACK_TERMINAL }, exposureOf("agents.tail1234.ts.net"))), tailnetTerminalOf(9444), "a loopback address is replaced");
  assert.equal(await terminalOf(board(4747, {}, exposureOf("agents.tail1234.ts.net"))), tailnetTerminalOf(9444), "an absent address is the exposure's");
  assert.equal(await terminalOf(board(4747, {}, exposureOf("agents.tail1234.ts.net", { ui: 9443, terminal: 9555 }))), tailnetTerminalOf(9555), "the terminal's port is the exposure's");
  const other = "https://other.example.ts.net/?ws={workspace}&pane={pane}&view=terminal";
  assert.equal(await terminalOf(board(4747, { terminal: other }, exposureOf("agents.tail1234.ts.net"))), other, "another machine's address is kept");
  const nameless = Object.assign(createFakeExposure("agents.tail1234.ts.net"), { machineName: async () => null });
  assert.equal(await terminalOf(board(4747, { terminal: LOOPBACK_TERMINAL }, { exposure: nameless })), LOOPBACK_TERMINAL, "a name that cannot be read hands over the stored address");
  assert.equal(await terminalOf(board(4747, { terminal: LOOPBACK_TERMINAL }, exposureOf(null))), LOOPBACK_TERMINAL, "an exposure that serves nothing changes nothing");
  assert.equal(await terminalOf(board(4747, { terminal: LOOPBACK_TERMINAL })), LOOPBACK_TERMINAL, "and a board given none serves on loopback");
});

test("an exposure that serves nothing is never asked for a name, and the name that cannot be read is said once", async () => {
  const local = createFakeExposure();
  await terminalOf(board(4747, { terminal: LOOPBACK_TERMINAL }, { exposure: local }));
  assert.deepEqual(local.calls, [], "loopback needs no name");
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { said.push(String(line)); return true; }) as typeof process.stderr.write;
  try {
    const b = board(4747, { terminal: LOOPBACK_TERMINAL }, { exposure: Object.assign(createFakeExposure("agents.tail1234.ts.net"), { machineName: async () => null }) });
    await terminalOf(b);
    await terminalOf(b);
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(said, ["ticket:serve: the exposure cannot name this machine (is it running?), so the board is handed the stored terminal address\n"]);
});

test("the instance answers no tailnet Host: it is reached on its loopback alone", () => {
  assert.match(refusal({ headers: { host: "agents.tail1234.ts.net:4747" }, method: "GET" }, 4747) ?? "", /answers only to its own host/);
});
// A11-84: THE INSTANCE CHECKS THE ROUTING WRAPPER AT START-UP IN A CHILD PROCESS, LOUDLY, AND STARTS ANYWAY. The child runs the host module's check, which these
// tests stub: what the check finds and re-renders is the host module's, tested in `packaging/gh-wrapper-guard.test.ts`.

test("A11-84: the start-up runs the host module's check in a child process, and a clean run says nothing", () => {
  const said: string[] = [];
  const asked: string[] = [];
  checkGhWrapperAtStart({ err: (line) => said.push(line), run: (program) => { asked.push(program); return { status: 0 }; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /host-units\/gh-wrapper-and-notes\.ts".*\.then\(\(host\) => host\.startupGhWrapper\(\)\)/s, "the child loads the host module and runs its check");
  assert.equal(said.join(""), "", "the child logs its own findings, so a clean start adds nothing");
});

test("A11-84: a child that exits non-zero is an ERROR line, and the instance is not stopped: the check returns", () => {
  const said: string[] = [];
  assert.doesNotThrow(() => checkGhWrapperAtStart({ err: (line) => said.push(line), run: () => ({ status: 1 }) }));
  assert.equal(said.join(""), "ERROR gh wrapper: cannot be checked (the check exited 1), so the instance does not know its App identity is in place\n");
});

test("A11-84: a child that cannot be started is an ERROR line, first line only, and the instance still starts", () => {
  const said: string[] = [];
  assert.doesNotThrow(() => checkGhWrapperAtStart({ err: (line) => said.push(line), run: () => ({ status: null, error: new Error("spawn node ENOENT\nmore") }) }));
  assert.equal(said.join(""), "ERROR gh wrapper: cannot be checked (spawn node ENOENT), so the instance does not know its App identity is in place\n");
});

test("the instance mints a worker terminal's code for its key only, and says why there is none when the terminal is not set", async () => {
  const port = await freePort();
  const made = board(port, {}, { mintTerminal: async () => ({ code: "123456" }) });
  const server = createServer((request, response) => { void made.handle(request, response); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  try {
    const wrong = await fetch(`http://127.0.0.1:${port}/api/terminal-pair`, { method: "POST", headers: { "x-ticket-token": "b".repeat(48) } });
    assert.equal(wrong.status, 401, "a request without the key is refused");
    const minted = await fetch(`http://127.0.0.1:${port}/api/terminal-pair`, { method: "POST", headers: { "x-ticket-token": KEY } });
    assert.deepEqual(await minted.json(), { code: "123456" });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  const unset = board();
  assert.deepEqual(await unset.api("POST", "/api/terminal-pair", {}), [200, { code: null, note: "tickets.terminal is not set" }]);
});

test("A11-129: /api/terminal-run says whether a worker link's terminal is a run's now, a run that has ended, or none the board holds", async () => {
  const b = board(4747, WRITER);
  b.store.set(queueWriter(b.store.get(), { id: "w1", request: "Show the requests", mode: "grill", form: {} }, 1));
  b.store.set(markWriterRunning(markWriterStarting(b.store.get(), "w1", 2), "w1", "w1", "w1:p1"));
  const link = "http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal";
  assert.deepEqual(await b.api("POST", "/api/terminal-run", { link }), [200, { state: "live" }], "a waiting or working run's terminal is live");
  b.store.set(writerFailed(b.store.get(), "w1", "its agent exited: its herdr workspace is gone", 3));
  assert.deepEqual(await b.api("POST", "/api/terminal-run", { link }), [200, { state: "ended", outcome: "failed", run: "w1", kind: "writer", reason: "its agent exited: its herdr workspace is gone" }]);
  assert.deepEqual(await b.api("POST", "/api/terminal-run", { link: "http://127.0.0.1:7318/?ws=w9&pane=w9%3Ap1&view=terminal" }), [200, { state: "unknown" }], "a terminal no run holds");
  assert.deepEqual(await b.api("POST", "/api/terminal-run", {}), [200, { state: "unknown" }], "a request that names no link holds none");
  const unset = board();
  assert.deepEqual(await unset.api("POST", "/api/terminal-run", { link }), [200, { state: "unknown" }], "a board with no terminal names none");
});

/*
 * New-ticket requests (A11-94): the routes queue a run of the writer, and only the approve route creates a ticket, in the tracker, with the person's approval.
 */

const WRITER = { writer: { run: "Run the a11ign:create-ticket skill for this request: {request}, in {dir}." }, terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal" };

/** A tracker that answers reads: it holds NBF-1, A11-12 and the tickets a run files. */
function creating(): TicketSource {
  return {
    assigned: async () => [ticket("NBF-1")],
    read: async (key) => (key === "NBF-1" || key === "A11-12" || key.startsWith("NBF-10") ? { ...ticket(key), team: key.split("-")[0] } as Ticket : null),
    download: async () => [],
  };
}

/** The writer's board, on a tracker that holds the tickets its runs file. */
function writerBoard() {
  return board(4747, WRITER, {}, creating());
}

/** The writer run `w7`, as the pool leaves it once its agent has filed the tickets its outcome names: finished, with each ticket shown (A11-135). */
function filedBy(b: ReturnType<typeof board>, tickets: readonly { key: string; url: string | null; inPick: boolean }[]) {
  b.store.set({ ...b.store.get(), writers: b.store.get().writers!.map((run) => ({ ...run, phase: "finished" as const, finishedAt: 4, tickets })) });
}


test("a new-ticket request is queued as a run of the writer and shown with its status, and is refused by name when it cannot be", async () => {
  const tracker = creating();
  const b = board(4747, WRITER, {}, tracker);
  const [status, writers] = await b.api("POST", "/api/writer", { request: "Show requests a person made", repo: "nbl-ui-netbox", priority: "high" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(writers.runs.map((r: any) => [r.request, r.mode, r.status, r.form]), [["Show requests a person made", "quick", "queued", { repo: "nbl-ui-netbox", priority: "high" }]]);
  assert.deepEqual(b.ticks, ["tick"], "the pool is woken to start it");
  await assert.rejects(b.api("POST", "/api/writer", { request: "" }), /a request is 1 to 8000 characters/);
  await assert.rejects(b.api("POST", "/api/writer", { request: "x".repeat(8001) }), /a request is 1 to 8000 characters/);
  await assert.rejects(b.api("POST", "/api/writer", { request: "a", repo: "elsewhere" }), /repo must be one of nbl-ui-netbox, platform-monorepo, not elsewhere/);
  await assert.rejects(b.api("POST", "/api/writer", { request: "a", priority: "hi" }), /priority must be one of urgent, high, medium, low, none, not hi/);
  await assert.rejects(b.api("POST", "/api/writer", { request: "a", parent: "NBF-404" }), /no ticket NBF-404/);
  const [graceful] = await b.api("POST", "/api/writer", { request: "a", mode: "grill" }) as [number, unknown];
  assert.equal(graceful, 200, "grill is allowed with a terminal to open in");
});

test("grill is refused without a terminal, and a machine with no writer writes no tickets", async () => {
  const tracker = creating();
  const plain = board(4747, { writer: WRITER.writer }, {}, tracker);
  await assert.rejects(plain.api("POST", "/api/writer", { request: "a", mode: "grill" }), /grill needs tickets.terminal/);
  const none = board(4747, {}, {}, tracker);
  await assert.rejects(none.api("POST", "/api/writer", { request: "a" }), /this machine names no tickets.writer, so it writes no tickets/);
  const [, config] = await none.api("GET", "/api/config", {}) as [number, any];
  assert.equal(config.writer, false, "the board hides New ticket");
  const [, configured] = await board(4747, WRITER, {}, tracker).api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual([configured.writer, configured.writerGrill, configured.repos], [true, true, ["nbl-ui-netbox", "platform-monorepo"]]);
  assert.ok(configured.priorities.includes("urgent"));
});

test("the settings save the ticket writer's model and effort apart from the others, and an empty value clears each", async () => {
  const b = board(4747, WRITER);
  const [, saved] = await b.api("POST", "/api/choice", { writerModel: "sonnet", writerEffort: "max" }) as [number, any];
  assert.deepEqual(saved.choice, { model: "opus", effort: "high", planModel: "opus", planEffort: "high", writerModel: "sonnet", writerEffort: "max" });
  const [, cleared] = await b.api("POST", "/api/choice", { writerEffort: "" }) as [number, any];
  assert.deepEqual(cleared.choice, { model: "opus", effort: "high", planModel: "opus", planEffort: "high", writerModel: "sonnet" }, "an empty effort clears the writer's effort alone");
  assert.equal("writerEffort" in JSON.parse(readFileSync(join(b.dir, "choice.json"), "utf8")), false, "and the file names no value for it");
  await assert.rejects(b.api("POST", "/api/choice", { writerModel: "gpt" }), /model must be one of/);
  await assert.rejects(b.api("POST", "/api/choice", { writerEffort: "huge" }), /effort must be one of/);
  assert.deepEqual(b.ticks, [], "a setting for new runs wakes nothing");
  writeFileSync(join(b.dir, "choice.json"), JSON.stringify({ writerModel: "gpt-9", writerEffort: "max" }));
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.choice, { model: "opus", effort: "high", planModel: "opus", planEffort: "high", writerEffort: "max" }, "a saved writer model the board no longer offers reads as not chosen");
});

test("a new-ticket request is stamped with the writer's model and effort in force: the host file's, then the one chosen, then the host file's once cleared", async () => {
  const tracker = creating();
  let tick = 0;
  // The board is built once, and the choice changes between the requests: the next request takes the change, with no restart.
  const b = board(4747, { ...WRITER, writer: { run: WRITER.writer.run, model: "sonnet", effort: "medium" } }, { now: () => (tick += 1) }, tracker);
  const requestRun = async (request: string) => {
    const [, writers] = await b.api("POST", "/api/writer", { request }) as [number, any];
    return writers.runs.at(-1);
  };
  const host = await requestRun("Show requests");
  assert.deepEqual([host.model, host.effort], ["sonnet", "medium"], "with no choice, the host file's");
  await b.api("POST", "/api/choice", { writerModel: "opus", writerEffort: "max" });
  const chosen = await requestRun("Show more requests");
  assert.deepEqual([chosen.model, chosen.effort], ["opus", "max"], "the choice in force for the next request");
  await b.api("POST", "/api/choice", { writerModel: "", writerEffort: "" });
  await requestRun("Show the last requests");
  assert.deepEqual(b.store.get().writers?.map((run) => [run.model, run.effort]), [["sonnet", "medium"], ["opus", "max"], ["sonnet", "medium"]], "each request keeps the choice it was queued with");
});

test("/api/config gives the ticket writer's host default, which is null on a machine that names no writer", async () => {
  const [, configured] = await board(4747, { ...WRITER, writer: { run: WRITER.writer.run, model: "sonnet", effort: "medium" } }).api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(configured.writerDefault, { model: "sonnet", effort: "medium" });
  const [, none] = await board(4747).api("GET", "/api/config", {}) as [number, any];
  assert.equal(none.writerDefault, null);
  assert.equal(none.choice.writerModel, undefined, "nothing chosen: the choice names no writer model");
});




test("the run files its own tickets, so there is no approve or discard route: a ticket's path is not a route, and a request's stop and dismiss are as before", async () => {
  const b = writerBoard();
  await b.api("POST", "/api/writer", { request: "Show requests" });
  const [approve] = await b.api("POST", "/api/writer/w7/drafts/d1/approve", { draft: {} }) as [number, any];
  const [discard] = await b.api("POST", "/api/writer/w7/drafts/d1/discard", {}) as [number, any];
  assert.deepEqual([approve, discard], [404, 404], "POSITIVE CONTROL: the review's routes are gone");
  await b.api("POST", "/api/writer/w7/stop", {});
  await assert.rejects(b.api("POST", "/api/writer/w7/dismiss", {}), /stop the new-ticket request before you dismiss it/, "a run still under way is not dismissed");
});

test("a run's filed tickets show on the run as links, with their key and address, and the page's view holds no draft to review", async () => {
  const b = writerBoard();
  await b.api("POST", "/api/writer", { request: "Show requests" });
  const [, filing] = await b.api("GET", "/api/writer", {}) as [number, any];
  assert.deepEqual(filing.runs[0].tickets, [], "no ticket while the run is filing");
  assert.equal("drafts" in filing.runs[0], false, "the page is not sent drafts to review");
  filedBy(b, [{ key: "NBF-101", url: "https://linear.app/x/NBF-101", inPick: true }]);
  const [, after] = await b.api("GET", "/api/writer", {}) as [number, any];
  assert.deepEqual([after.runs[0].status, after.runs[0].tickets], ["done", [{ key: "NBF-101", url: "https://linear.app/x/NBF-101", inPick: true }]]);
  filedBy(b, [{ key: "NBF-102", url: null, inPick: false }]);
  const [, unaddressed] = await b.api("GET", "/api/writer", {}) as [number, any];
  assert.deepEqual(unaddressed.runs[0].tickets, [{ key: "NBF-102", url: null, inPick: false }], "a ticket the tracker has no address for is shown by its key");
});

test("stopping a run keeps what it wrote, and a request whose run is not known is refused by name", async () => {
  const b = board(4747, WRITER, {}, creating());
  await b.api("POST", "/api/writer", { request: "Show requests" });
  const [, stopped] = await b.api("POST", "/api/writer/w7/stop", {}) as [number, any];
  assert.deepEqual(b.ticks.filter((t) => t.startsWith("stop-writer")), ["stop-writer w7"], "the pool stops the run");
  assert.equal(stopped.runs.length, 1);
  await assert.rejects(b.api("POST", "/api/writer/nope/stop", {}), /no new-ticket request nope/);
});

test("A11-106: the feedback sweeps are each scheduled on the feedback cadence, and a sweep that throws does not stop the others", () => {
  const calls: string[] = [];
  const pool = {
    watchFeedback: () => { calls.push("watchFeedback"); throw new Error("the feed is down"); },
    releaseReviewers: () => { calls.push("releaseReviewers"); },
    retargetStacked: () => { calls.push("retargetStacked"); },
    rebaseStacked: async () => { calls.push("rebaseStacked"); },
    reviewNewHeads: () => { calls.push("reviewNewHeads"); },
  };
  const scheduled: { run: () => void; ms: number }[] = [];
  startFeedbackSweeps(pool, (run, ms) => { scheduled.push({ run, ms }); });
  assert.deepEqual(scheduled.map(({ ms }) => ms), [FEEDBACK_MS, FEEDBACK_MS, FEEDBACK_MS, FEEDBACK_MS, FEEDBACK_MS], "each sweep is on the feedback cadence");
  const stderr = process.stderr.write;
  const said: string[] = [];
  process.stderr.write = ((line: string) => { said.push(line); return true; }) as typeof process.stderr.write;
  try {
    for (const { run } of scheduled) run();
  } finally {
    process.stderr.write = stderr;
  }
  assert.deepEqual(calls, ["watchFeedback", "releaseReviewers", "retargetStacked", "rebaseStacked", "reviewNewHeads"], "the failing sweep is said, and the others still run");
  assert.deepEqual(said, ["ticket:serve: the pull requests' feedback could not be read: the feed is down\n"]);
});

test("A11-106: the stacked pull requests' sweep is the one scheduled with retargetStacked, not another", () => {
  const retargeted: string[] = [];
  const scheduled: (() => void)[] = [];
  startFeedbackSweeps({ watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => { retargeted.push("retargetStacked"); }, rebaseStacked: async () => {}, reviewNewHeads: () => {} },
    (run) => { scheduled.push(run); });
  scheduled[2]();
  assert.deepEqual(retargeted, ["retargetStacked"], "the third sweep is retargetStacked");
});

test("A11-116: the stacked branches' sweep is scheduled on the feedback cadence, and a rebase that fails asynchronously is said, not lost", async () => {
  const scheduled: (() => void)[] = [];
  const ms: number[] = [];
  startFeedbackSweeps({ watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: () => Promise.reject(new Error("git is gone")), reviewNewHeads: () => {} },
    (run, every) => { scheduled.push(run); ms.push(every); });
  assert.equal(ms[3], FEEDBACK_MS, "the fourth sweep is the stacked branches'");
  const stderr = process.stderr.write;
  const said: string[] = [];
  process.stderr.write = ((line: string) => { said.push(line); return true; }) as typeof process.stderr.write;
  try {
    scheduled[3]();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.stderr.write = stderr;
  }
  assert.deepEqual(said, ["ticket:serve: the stacked branches could not be rebased: git is gone\n"]);
});

// A board whose list is the key's own reads the rest one scope at a time (the key's workspace holds thousands of open tickets, past what one answer carries).
const HOLDS = { people: [{ id: "dan", name: "Dan Beck", count: 1 }, { id: "ana", name: "Ana Ruiz", count: 2 }], unassigned: 3, total: 6 };
const onDemand = (over: Partial<TicketSource> = {}): TicketSource => ({
  assigned: async () => [ticket("NBF-1")], read: async () => null, download: async () => [], people: async () => HOLDS,
  scoped: async (scope, after) => ({ tickets: [ticket(`${scope}-${after ?? "first"}`)], next: after === null ? "c1" : null }), ...over,
});

test("on demand: the config says the scopes are read one at a time, only where the list is the key's own and the source can read them", async () => {
  const [, own] = await board(4747, {}, {}, onDemand()).api("GET", "/api/config", {}) as [number, any];
  assert.equal(own.scopes, true);
  const [, team] = await board(4747, { pick: { team: "A11" } }, {}, onDemand()).api("GET", "/api/config", {}) as [number, any];
  assert.equal(team.scopes, false, "a team's list holds every ticket of it already");
  const [, bare] = await board(4747, {}, {}, onDemand({ people: undefined })).api("GET", "/api/config", {}) as [number, any];
  assert.equal(bare.scopes, false, "a source that cannot count who holds the tickets lists what it has");
});

test("on demand: /api/people answers who holds the tickets, read once and kept for the next asks, and never twice at once", async () => {
  let asked = 0;
  const b = board(4747, {}, {}, onDemand({ people: async () => { asked += 1; await new Promise((resolve) => setImmediate(resolve)); return HOLDS; } }));
  const [first, second] = await Promise.all([b.api("GET", "/api/people", {}), b.api("GET", "/api/people", {})]);
  assert.deepEqual([first, second], [[200, HOLDS], [200, HOLDS]]);
  await b.api("GET", "/api/people", {});
  assert.equal(asked, 1, "one read serves the asks that come while it runs and after it");
});

test("on demand: /api/tickets?assignee= answers a page of that scope with the next cursor, and the tickets join those the parents are read for", async () => {
  const b = board(4747, {}, {}, onDemand());
  const [status, page] = await b.api("GET", "/api/tickets", {}, new URLSearchParams("assignee=ana")) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual([page.tickets.map((t: any) => t.key), page.next], [["ana-first"], "c1"]);
  const [, after] = await b.api("GET", "/api/tickets", {}, new URLSearchParams("assignee=ana&after=c1")) as [number, any];
  assert.deepEqual([after.tickets.map((t: any) => t.key), after.next], [["ana-c1"], null]);
});

test("on demand: an instance that lists everything at once answers neither /api/people nor a scope, and /api/tickets without a scope is the list as before", async () => {
  const b = board(4747, { pick: { team: "A11" } }, {}, onDemand());
  assert.equal((await b.api("GET", "/api/people", {}))[0], 404);
  assert.equal((await b.api("GET", "/api/tickets", {}, new URLSearchParams("assignee=ana")))[0], 404);
  const [, list] = await b.api("GET", "/api/tickets", {}) as [number, any[]];
  assert.deepEqual(list.map((t) => t.key), ["NBF-1"]);
});

test("on demand: the parents of a scope's tickets are read, as those of the first list are, so the Pick view can nest them", async () => {
  const read: string[] = [];
  const b = board(4747, {}, {}, onDemand({ scoped: async () => ({ tickets: [{ ...ticket("NBF-9"), parent: "NBF-8" }], next: null }), read: async (key) => { read.push(key); return ticket(key); } }));
  await b.api("GET", "/api/tickets", {}, new URLSearchParams("assignee=ana"));
  const [, parents] = await b.api("GET", "/api/parents", {}) as [number, any[]];
  assert.deepEqual([read, parents.map((t) => t.key)], [["NBF-8"], ["NBF-8"]]);
});

test("preflight: the queue the page reads says why runs are held, in every answer that carries the queue, and null while none is", async () => {
  const b = board();
  const [, calm] = await b.api("GET", "/api/queue", {}) as [number, any];
  assert.equal(calm.held, null);
  b.hold({ name: "fontawesome login", reason: "EXPIRED: run assume repo-resources", since: 5 });
  const [, held] = await b.api("GET", "/api/queue", {}) as [number, any];
  assert.deepEqual(held.held, { name: "fontawesome login", reason: "EXPIRED: run assume repo-resources", since: 5 });
  assert.ok(Array.isArray(held.entries), "the queue itself is still there");
  const [, queued] = await b.api("POST", "/api/queue", { keys: ["VE-9"], model: "opus", effort: "high" }) as [number, any];
  assert.equal(queued.held?.name, "fontawesome login", "an answer to a queue change carries it too, so the banner does not flicker");
});

test("preflight: the answer to Queue its children carries why runs are held, as every other answer with the queue does", async () => {
  const b = epicBoard(async () => new Map());
  await b.api("GET", "/api/tickets", {});
  const [, calm] = await b.api("POST", "/api/queue-children", { key: "A11-24", model: "opus", effort: "high" }) as [number, any];
  assert.equal(calm.queue.held, null);
  b.hold({ name: "fontawesome login", reason: "EXPIRED: run assume repo-resources", since: 5 });
  const [, held] = await b.api("POST", "/api/queue-children", { key: "A11-24", model: "opus", effort: "high" }) as [number, any];
  assert.deepEqual(held.queue.held, { name: "fontawesome login", reason: "EXPIRED: run assume repo-resources", since: 5 });
  assert.ok(Array.isArray(held.queue.entries), "the queue itself is still there");
});

test("preflight: every answer that carries the queue carries the held state, so the notice cannot flicker off after an action", async () => {
  const b = epicBoard(async () => new Map());
  b.hold({ name: "disk", reason: "only 2 GB free", since: 5 });
  await b.api("GET", "/api/tickets", {});
  const answers: [string, string, Record<string, unknown>][] = [
    ["GET", "/api/queue", {}],
    ["POST", "/api/paused", { paused: false }],
    ["POST", "/api/max", { max: 2 }],
    ["POST", "/api/queue", { keys: ["A11-25"], model: "opus", effort: "high" }],
  ];
  for (const [method, path, body] of answers) {
    const [, answer] = await b.api(method, path, body) as [number, any];
    assert.equal(answer.held?.name, "disk", `${method} ${path}`);
  }
});

test("/api/settings reads the host file fresh on each request: a refused key shows its message, and an edit shows on the next read", async () => {
  const dir = tmpDir("ticket-server-settings-");
  const hostPath = join(dir, "host.json");
  const host = (tickets: Record<string, unknown>) => JSON.stringify({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets });
  writeFileSync(hostPath, host({ drafts: "yes", max: 2 }));
  const b = board(4747, {}, { hostPath });
  const [status, view] = await b.api("GET", "/api/settings", {}) as [number, View];
  assert.equal(status, 200);
  assert.equal(view.refusals.length, 1, "one refusal: the tickets block");
  assert.match(view.refusals[0].message, /`tickets\.drafts`/, "the refusal names the field");
  assert.equal(view.groups.flatMap((group) => group.rows).some((candidate) => candidate.key === "tickets.max"), false, "the refused block draws none of its keys");
  assert.ok(view.notes.some((note) => /declares no project/.test(note)), "a board-only machine says it declares no project");
  writeFileSync(hostPath, host({ drafts: false, max: 2 }));
  const [, again] = await b.api("GET", "/api/settings", {}) as [number, View];
  assert.deepEqual(again.refusals, [], "the edit is read at once, with no restart");
  const drafts = again.groups.flatMap((group) => group.rows).find((candidate) => candidate.key === "tickets.drafts");
  assert.deepEqual([drafts?.state, drafts?.value], ["disabled", "false"]);
});

test("/api/settings says a host file that cannot be read by its path, and is refused for a POST", async () => {
  const dir = tmpDir("ticket-server-settings-missing-");
  const hostPath = join(dir, "absent.json");
  const b = board(4747, {}, { hostPath });
  const [status, view] = await b.api("GET", "/api/settings", {}) as [number, View];
  assert.equal(status, 200);
  assert.deepEqual(view.refusals.map((r) => r.message), [`ticket mode: \`AGENT_ORG_HOST\` names ${hostPath}, which cannot be read`]);
  const [posted] = await b.api("POST", "/api/settings", { drafts: false });
  assert.equal(posted, 404, "the settings page is read-only: no route takes a POST");
});

test("A11-132: the Settings edit routes preview, save and restore one file through the readers: a refused value is the reader's message, and a file is named by its kind only", async () => {
  const dir = tmpDir("ticket-server-edit-");
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, JSON.stringify({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { drafts: true, max: 2 } }, null, 2));
  const before = readFileSync(hostPath, "utf8");
  const b = board(4747, {}, { hostPath });
  await assert.rejects(b.api("POST", "/api/settings/preview", { file: "host.json", changes: [{ key: "tickets.port", value: "x" }] }), /tickets\.port/);
  await assert.rejects(b.api("POST", "/api/settings/preview", { file: join(dir, "elsewhere.json"), changes: [] }), /file must be host\.json or project\.json/);
  assert.equal(readFileSync(hostPath, "utf8"), before, "a refused preview writes nothing");
  const [, preview] = await b.api("POST", "/api/settings/preview", { file: "host.json", changes: [{ key: "tickets.drafts", value: false }] }) as [number, { base: string; changes: { old: string; new: string }[] }];
  assert.deepEqual(preview.changes.map(({ old, new: now }) => [old, now]), [["true", "false"]]);
  await assert.rejects(b.api("POST", "/api/settings/save", { file: "host.json", changes: [{ key: "tickets.drafts", value: false }], base: preview.base }), /second confirmation/);
  const [saved] = await b.api("POST", "/api/settings/save", { file: "host.json", changes: [{ key: "tickets.drafts", value: false }], base: preview.base, confirmed: ["tickets.drafts"] }) as [number, unknown];
  assert.equal(saved, 200);
  assert.match(readFileSync(hostPath, "utf8"), /"drafts": false/);
  const [restored] = await b.api("POST", "/api/settings/restore", { file: "host.json" }) as [number, unknown];
  assert.equal(restored, 200);
  assert.equal(readFileSync(hostPath, "utf8"), before, "the restore puts the file back");
  const [posted] = await b.api("POST", "/api/settings", { drafts: false });
  assert.equal(posted, 404, "the read-only route takes no POST, and the edits have their own paths");
});

test("/api/settings reads the project of the host file the suite runs against, through the real project reader, and draws its keys", { skip: process.env.AGENT_ORG_HOST ? false : "needs AGENT_ORG_HOST, as the suite sets it" }, async () => {
  const b = board(4747, {}, { hostPath: process.env.AGENT_ORG_HOST! });
  const [status, view] = await b.api("GET", "/api/settings", {}) as [number, View];
  assert.equal(status, 200);
  assert.equal(view.notes.some((note) => /declares no project/.test(note)), false, "a machine with a project declared is not a board-only one");
  assert.ok(view.groups.flatMap((group) => group.rows).some((candidate) => candidate.file === "project.json"), "the project's keys are drawn from its file");
});

/** A ticket the tracker holds with an open decision in its Acceptance: the page is sent it with `needsDecision` (A11-134). */
const DECIDING = { ...ticket("A11-50"), description: "## Acceptance\n\n- Decide whether the list sorts.\n" } as Ticket;

test("A11-134: the page is sent each ticket's open decision as needsDecision, and a ticket with none is sent without one", async () => {
  const tracker: TicketSource = createFakeTracker([DECIDING, ticket("NBF-2")]);
  const [, tickets] = await board(4747, {}, {}, tracker).api("GET", "/api/tickets", {}) as [number, any[]];
  assert.match(tickets[0].needsDecision.reason, /An open decision is still in acceptance: "- Decide whether the list sorts\."/);
  assert.equal(tickets[1].needsDecision, undefined);
});

test("A11-134: the queue refuses a ticket with an open decision, naming its line, and Queue its children leaves such a sub-issue out and names it", async () => {
  const sub = { ...ticket("A11-51"), description: "" } as Ticket;
  const tracker: TicketSource = {
    assigned: async () => [DECIDING],
    read: async (key) => (key === "A11-24" ? { ...ticket(key), children: ["A11-50", "A11-51"] } : key === "A11-50" ? DECIDING : key === "A11-51" ? sub : null),
    download: async () => [],
  };
  const b = board(4747, {}, {}, tracker);
  await b.api("GET", "/api/tickets", {});
  await assert.rejects(b.api("POST", "/api/queue", { keys: ["A11-50"], model: "opus", effort: "high" }),
    /^Error: A11-50: An open decision is still in acceptance: "- Decide whether the list sorts\.". Grill it to settle the decision before it is queued\.$/);
  assert.deepEqual(b.store.get().entries, [], "nothing is queued");
  const [, answer] = await b.api("POST", "/api/queue-children", { key: "A11-24", model: "opus", effort: "high" }) as [number, any];
  assert.deepEqual(answer.keys, ["A11-51"]);
  assert.match(answer.note, /A11-50 holds an open decision, so not queued: Grill it first/);
});

test("A11-134: a ticket the page copied with an open decision is queued once its tracker text is settled, since the queue reads it again", async () => {
  const tracker = createFakeTracker([DECIDING]);
  const b = board(4747, {}, {}, tracker);
  await b.api("GET", "/api/tickets", {});
  tracker.seed({ ...DECIDING, description: `${DECIDING.description}\n**Decisions:** settled\n` });
  const [status, queue] = await b.api("POST", "/api/queue", { keys: ["A11-50"], model: "opus", effort: "high" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(queue.entries.map((e: any) => e.ticket.key), ["A11-50"]);
});

test("A11-134: Grill on a ticket with an open decision queues a grill run on it that files nothing and keeps the text it started from, and is refused without a terminal or a settled ticket", async () => {
  const tracker: TicketSource = createFakeTracker([DECIDING, ticket("NBF-1")]);
  const b = board(4747, WRITER, {}, tracker);
  const [status, writers] = await b.api("POST", "/api/grill-ticket", { key: "A11-50" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(writers.runs.map((r: any) => [r.request, r.mode, r.status, r.ticket]), [["Grill A11-50", "grill", "queued", "A11-50"]]);
  assert.equal(writers.runs[0].startedFrom, undefined, "the text it started from is kept on the board, not sent to the page");
  const [, view] = await b.api("GET", "/api/queue", {}) as [number, any];
  assert.equal(view.writers[0].startedFrom, undefined, "the queue the page reads holds no Grill run's ticket text either");
  assert.deepEqual(b.ticks, ["tick"], "the pool is woken to start it");
  await assert.rejects(b.api("POST", "/api/grill-ticket", { key: "NBF-1" }), /NBF-1 has no open decision and no screen behaviour to grill/);
  await assert.rejects(b.api("POST", "/api/grill-ticket", { key: "A11-404" }), /no ticket A11-404/);
  const plain = board(4747, { writer: WRITER.writer }, {}, tracker);
  await assert.rejects(plain.api("POST", "/api/grill-ticket", { key: "A11-50" }), /Grill needs a terminal: name tickets.terminal in the host file/);
});

// ---- A11-163: the Settings page's Plugins section

type PluginsView = Awaited<ReturnType<import("./plugins-api.ts").PluginsApi["read"]>>;
type Acted = { said: string; changed: boolean; inForce: string[] };

/** A board over a scratch host file, with the plugins' seam replaced so no plugin module is imported and no program runs. */
function pluginsBoard(providers: Record<string, unknown>) {
  const dir = tmpDir("ticket-server-plugins-");
  const hostPath = join(dir, "host.json");
  const text = (blocks: Record<string, unknown>) => `${JSON.stringify({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { providers: blocks } }, null, 2)}\n`;
  writeFileSync(hostPath, text(providers));
  const released: string[] = [];
  const plugins = {
    load: async () => ({ loaded: [], unbuilt: [], refusals: [] }),
    messaging: { state: async () => ({ provider: null, why: "this machine declares no project, so messaging is not configured" }) as const, checks: async () => [] },
    version: "v1.2.3",
    outgoing: async (plugin: { name: string }) => ({ machineName: null, release: () => { released.push(plugin.name); return { ok: true, detail: "" }; } }),
  };
  return { ...board(4747, {}, { hostPath, plugins }), hostPath, released, text, plugins };
}
const FRESH_BLOCKS = { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", port: 5000 } };
/** What the page reads of the plugins, and what it sends an action. */
const readPlugins = async (b: ReturnType<typeof pluginsBoard>) => (await b.api("GET", "/api/plugins", {}) as [number, PluginsView])[1];
const actOn = async <T = Acted>(b: ReturnType<typeof pluginsBoard>, body: Record<string, unknown>) => await b.api("POST", "/api/plugins/action", body) as [number, T];
/** What an action the instance refuses answers: a 400, and the sentence. */
async function refusalOf(b: ReturnType<typeof pluginsBoard>, body: Record<string, unknown>): Promise<string> {
  const [status, answer] = await actOn<{ error: string }>(b, body);
  assert.equal(status, 400);
  return answer.error;
}
/** What an action the instance carries out says it did: a 200, and the sentence. */
async function saidBy(b: ReturnType<typeof pluginsBoard>, body: Record<string, unknown>): Promise<string> {
  const [status, done] = await actOn(b, body);
  assert.equal(status, 200);
  return done.said;
}
/** A board over the fresh blocks, with the plugins read once and the base of the host file the page would send back. */
async function opened() {
  const b = pluginsBoard(FRESH_BLOCKS);
  const view = await readPlugins(b);
  return { b, view, base: view.bases["host.json"] };
}
const entryOf = (view: PluginsView, name: string) => view.concerns.flatMap((concern) => concern.plugins).find((plugin) => plugin.name === name)!;

test("A11-163: GET /api/plugins answers every concern in order with each plugin's name, version, contract and state, from the block that names it", async () => {
  const b = pluginsBoard(FRESH_BLOCKS);
  const [status, view] = await b.api("GET", "/api/plugins", {}) as [number, PluginsView];
  assert.equal(status, 200);
  assert.deepEqual(view.concerns.map(({ concern }) => concern), ["tracker", "codeHost", "publisher", "reviewer", "exposure", "messaging"]);
  assert.deepEqual(["linear", "github", "tailscale", "local", "slack"].map((name) => { const e = entryOf(view, name); return [name, e.version, e.contract, e.state]; }),
    [["linear", "v1.2.3", "1.4", "enabled"], ["github", "v1.2.3", "1.11", "enabled"], ["tailscale", "v1.2.3", "1.1", "enabled"], ["local", "v1.2.3", "1.1", "not installed"], ["slack", "v1.2.3", "1.1", "not installed"]]);
  assert.equal(view.concerns.find(({ concern }) => concern === "publisher")?.empty?.text, "None");
  assert.deepEqual(Object.keys(view.bases).sort(), ["host.json"], "this machine declares no project, so only the host file has a base");
  assert.equal(view.note, null);
  assert.doesNotMatch(JSON.stringify(view), /lin_api_|BEGIN .*PRIVATE KEY/, "no secret is in the answer, only the commands that set one");
});

test("A11-163: the Plugins call does not wait on the rest of the page: /api/settings answers while the plugins are still loading, and fails alone", async () => {
  const b = pluginsBoard(FRESH_BLOCKS);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => { release = done; });
  const stuck = board(4747, {}, { hostPath: b.hostPath, plugins: { ...b.plugins, load: async () => { await gate; return { loaded: [], unbuilt: [], refusals: [] }; } } });
  const pending = stuck.api("GET", "/api/plugins", {});
  const [status] = await stuck.api("GET", "/api/settings", {}) as [number, unknown];
  assert.equal(status, 200, "the settings are read while the plugins are not");
  release();
  assert.equal((await pending)[0], 200);
  const broken = board(4747, {}, { hostPath: b.hostPath, plugins: { ...b.plugins, load: async () => { throw new Error("loader down"); } } });
  await assert.rejects(broken.api("GET", "/api/plugins", {}), /loader down/);
  assert.equal((await broken.api("GET", "/api/settings", {}))[0], 200, "a failed Plugins call leaves the settings readable");
});

test("A11-163: Disable and Enable round trip through the host file, keep the person's notes, and say the change is in force when the board restarts", async () => {
  const b = pluginsBoard(FRESH_BLOCKS);
  const view = await readPlugins(b);
  const [status, off] = await actOn(b, { action: "disable", name: "tailscale", base: view.bases["host.json"] });
  assert.equal(status, 200);
  assert.match(off.said, /^disabled tailscale: the board is served on loopback only, and its settings are kept for `enable`$/);
  assert.match(off.inForce.join(" "), /^in force after the instance, the page and the terminal restart/, "the exposure says what must restart");
  assert.equal(JSON.parse(readFileSync(b.hostPath, "utf8")).tickets.providers.exposure.enabled, false);
  assert.equal(JSON.parse(readFileSync(b.hostPath, "utf8")).tickets.providers.exposure.port, 5000, "its settings are kept");
  assert.ok(existsSync(`${b.hostPath}.bak`), "the file before the change is kept beside it");
  assert.deepEqual(b.released, ["tailscale"], "the plugin was released while it was still the enabled one");
  const after = await readPlugins(b);
  assert.equal(entryOf(after, "tailscale").state, "disabled");
  const [, on] = await actOn(b, { action: "enable", name: "tailscale", base: after.bases["host.json"] });
  assert.match(on.said, /^enabled tailscale/);
  assert.equal(JSON.parse(readFileSync(b.hostPath, "utf8")).tickets.providers.exposure.enabled, true);
});

test("A11-161: the Settings page lists slack and atomic with their folders and states, and Disable and Enable of each round trip through the host file, with the settings kept: no core change", async () => {
  const publish = { provider: "slack", run: "post {prs} into {dir}", connectors: ["^mcp__chat__send"] };
  const b = pluginsBoard({ ...FRESH_BLOCKS, publish, reviewer: { provider: "atomic" } });
  const view = await readPlugins(b);
  assert.deepEqual(["slack", "atomic"].map((name) => { const e = entryOf(view, name); return [name, e.where, e.contract, e.state]; }),
    [["slack", "plugins/slack", "1.1", "enabled"], ["atomic", "plugins/atomic-reviewer", "1.3", "enabled"]]);
  const hostBlock = (block: string) => JSON.parse(readFileSync(b.hostPath, "utf8")).tickets.providers[block];
  const off = await saidBy(b, { action: "disable", name: "slack", base: view.bases["host.json"] });
  assert.match(off, /^disabled slack: the board publishes nothing, and its settings are kept for `enable`$/);
  assert.deepEqual(hostBlock("publish"), { ...publish, enabled: false }, "disabled, with its run and connectors kept");
  const after = await readPlugins(b);
  assert.equal(entryOf(after, "slack").state, "disabled");
  assert.match(await saidBy(b, { action: "enable", name: "slack", base: after.bases["host.json"] }), /^enabled slack: it is the publisher again, with the settings it kept$/);
  assert.deepEqual(hostBlock("publish"), { ...publish, enabled: true });
  const reviewer = await readPlugins(b);
  assert.match(await saidBy(b, { action: "disable", name: "atomic", base: reviewer.bases["host.json"] }), /^disabled atomic: the board starts no reviewer, and its settings are kept for `enable`$/);
  assert.deepEqual(hostBlock("reviewer"), { provider: "atomic", enabled: false });
  assert.equal(entryOf(await readPlugins(b), "atomic").state, "disabled");
});

test("A11-163: disabling the only tracker is refused with the CLI's sentence naming it, and nothing is written", async () => {
  const b = pluginsBoard(FRESH_BLOCKS);
  const before = readFileSync(b.hostPath, "utf8");
  const view = await readPlugins(b);
  const refused = await refusalOf(b, { action: "disable", name: "linear", base: view.bases["host.json"] });
  assert.equal(refused, "linear is the only tracker, and exactly one tracker must be enabled: it cannot be disabled");
  assert.equal(readFileSync(b.hostPath, "utf8"), before);
  assert.equal(existsSync(`${b.hostPath}.bak`), false, "no backup either: nothing was written");
  assert.equal(entryOf(view, "linear").controls.refused.disable, refused, "and the page was told the same sentence beforehand");
});

test("A11-163: Install of a plugin that takes a block another holds is the switch, asks to be confirmed, keeps the settings both declare and releases the plugin it leaves", async () => {
  const { b, view, base } = await opened();
  assert.match(await refusalOf(b, { action: "install", name: "local", base }), /^install local needs the person's confirmation first/);
  assert.equal(JSON.parse(readFileSync(b.hostPath, "utf8")).tickets.providers.exposure.provider, "tailscale", "nothing changed");
  assert.match(entryOf(view, "local").controls.confirm.install ?? "", /^Install local\? It replaces tailscale as the exposure: no setting is lost\.$/);
  assert.match(await saidBy(b, { action: "install", name: "local", base, confirmed: true }), /^switched the exposure from tailscale to local, keeping port/);
  const block = JSON.parse(readFileSync(b.hostPath, "utf8")).tickets.providers.exposure;
  assert.deepEqual([block.provider, block.enabled, block.port], ["local", true, 5000]);
  assert.deepEqual(b.released, ["tailscale"]);
});

test("A11-163: Uninstall is confirmed first, then removes the block so the concern takes its default", async () => {
  const { b, view, base } = await opened();
  assert.match(await refusalOf(b, { action: "uninstall", name: "tailscale", base }), /needs the person's confirmation first/);
  assert.match(entryOf(view, "tailscale").controls.confirm.uninstall ?? "", /^Uninstall tailscale\? Its block is removed, with its settings/);
  assert.match(await saidBy(b, { action: "uninstall", name: "tailscale", base, confirmed: true }), /^uninstalled tailscale: the exposure falls back to its default, local/);
  assert.equal("exposure" in JSON.parse(readFileSync(b.hostPath, "utf8")).tickets.providers, false);
  assert.equal(entryOf(await readPlugins(b), "tailscale").state, "not installed");
});

test("A11-163: an action sent for a file that changed since the page read it is refused, and nothing is written or released", async () => {
  const { b, base } = await opened();
  writeFileSync(b.hostPath, b.text({ ...FRESH_BLOCKS, exposure: { provider: "tailscale", port: 5001 } }));
  const changed = readFileSync(b.hostPath, "utf8");
  assert.equal(await refusalOf(b, { action: "disable", name: "tailscale", base }), "the file changed since you looked: read it again");
  assert.equal(readFileSync(b.hostPath, "utf8"), changed);
  assert.deepEqual(b.released, [], "the plugin was not released for a change that was refused");
});

test("A11-163: an action is refused by name when its words are wrong: an unknown action, a plugin that does not exist, a missing base", async () => {
  const { b, base } = await opened();
  const answer = (body: Record<string, unknown>) => actOn<{ error: string }>(b, body);
  assert.match((await answer({ action: "delete", name: "linear", base }))[1].error, /^action must be one of install, enable, disable, uninstall/);
  assert.match((await answer({ action: "enable", name: "nope", base }))[1].error, /^no plugin is named nope/);
  assert.match((await answer({ action: "enable", name: "tailscale" }))[1].error, /^base must be the hash of the file as you read it/);
  assert.match((await answer({ action: "install", name: "fake-exposure", base }))[1].error, /fake-exposure is an in-memory exposure for core's tests/);
});

test("A11-163: a host file the reader refuses is said in the plugins' answer, which then shows the defaults and carries no settings of the messaging key", async () => {
  const b = pluginsBoard(FRESH_BLOCKS);
  writeFileSync(b.hostPath, JSON.stringify({ clones: {}, tickets: { providers: { tracker: { provider: "jira" } } } }));
  const refusing = await readPlugins(b);
  assert.match(refusing.note ?? "", /^the host file is refused, so the plugins are shown as their defaults: /);
  const pasted = board(4747, {}, { hostPath: b.hostPath, plugins: { ...b.plugins, messaging: { state: async () => ({ provider: "telegram", enabled: true, settings: { pasted: "123:SECRET-TOKEN" } }), checks: async () => [] } } });
  const [, answer] = await pasted.api("GET", "/api/plugins", {}) as [number, PluginsView];
  assert.doesNotMatch(JSON.stringify(answer), /SECRET-TOKEN/, "a key pasted into the messaging key is never sent to the page");
});

test("A11-167: the queue is sent to the page without the copies of the ticket's text the board keeps to tell a change by, and with the change it shows", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" });
  const read = { updatedAt: "2026-10-21T09:00:00.000Z", hash: "0".repeat(64), description: "The ticket as it was.", readAt: 1 };
  const change = { at: 5, from: "The ticket as it was.", to: "The ticket now." };
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, briefedAgainst: read, plannedAgainst: { ...read, files: [], named: [] }, ticketChange: change })) });
  const [, queue] = await b.api("GET", "/api/queue", {}) as [number, { entries: Record<string, unknown>[] }];
  assert.deepEqual([queue.entries[0].briefedAgainst, queue.entries[0].plannedAgainst], [undefined, undefined]);
  assert.deepEqual(queue.entries[0].ticketChange, change, "the page draws What changed from the change");
  assert.ok(b.store.get().entries[0].briefedAgainst !== undefined, "the board's own copy is kept");
  const more = [change, { ...change, at: 6, to: "The ticket later." }];
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, ticketChanges: more, talkFrom: { ...e, briefedAgainst: read } })) });
  const [, again] = await b.api("GET", "/api/queue", {}) as [number, { entries: { ticketChanges: unknown[]; talkFrom: Record<string, unknown> }[] }];
  assert.deepEqual(again.entries[0].ticketChanges, [more[1]], "only the latest change is drawn");
  assert.equal(again.entries[0].talkFrom.briefedAgainst, undefined, "and a talk session's copy of the run it replaced is sent as that run is");
});
