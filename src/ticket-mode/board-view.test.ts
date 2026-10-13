// no-token: gh -- pure functions, and a fake storage
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDED_BACK, NO_PROJECT, RUN_STATUSES, flatten, groupByStatus, isParked, parentKeys, parentTick, ticketCount, projectCounts, queueLabel, recall, remember, runActions, runStatus, runsShown, selectable, statusCounts, terminalLink, toggled, waitsOn,
  visibleTickets, type ViewEntry, type ViewTicket,
} from "./board-view.ts";

const t = (key: string, status: string, statusOrder: number, priority: number, project: string | null, title = key): ViewTicket =>
  ({ key, title, status, statusOrder, priority, project });
const TICKETS = [
  t("NBF-1", "Backlog", 0, 3, "Visual Explorer - GA", "Fit to View does nothing"),
  t("NBF-2", "Backlog", 0, 1, "Visual Explorer - GA", "Racks removed on Save"),
  t("NBF-3", "Backlog", 0, 0, null, "Favicon"),
  t("NBCA-4", "In Progress", 2, 2, "Billing", "Stripe card"),
  t("NBCA-5", "Todo", 1, 0, "Billing", "Plan picker"),
];
const keys = (tickets: readonly ViewTicket[]) => tickets.map((x) => x.key);

test("no project chosen shows every ticket; chosen projects show only theirs, several at once, and (no project) is one of them", () => {
  assert.deepEqual(keys(visibleTickets(TICKETS, new Set(), "")), ["NBF-1", "NBF-2", "NBF-3", "NBCA-4", "NBCA-5"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, new Set(["Billing"]), "")), ["NBCA-4", "NBCA-5"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, new Set(["Billing", NO_PROJECT]), "")), ["NBF-3", "NBCA-4", "NBCA-5"]);
});

test("the search narrows within the chosen projects, matching key, title or project, in any case", () => {
  assert.deepEqual(keys(visibleTickets(TICKETS, new Set(["Visual Explorer - GA"]), "  RACKS ")), ["NBF-2"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, new Set(), "nbca")), ["NBCA-4", "NBCA-5"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, new Set(["Billing"]), "racks")), [], "a search outside the chosen projects finds nothing");
});

test("project chips count their tickets, most first, then by name", () => {
  assert.deepEqual(projectCounts(TICKETS), [["Billing", 2], ["Visual Explorer - GA", 2], [NO_PROJECT, 1]]);
});

test("groups follow the workflow's order, and within a group urgent comes first and no priority last", () => {
  const groups = groupByStatus(TICKETS);
  assert.deepEqual(groups.map(([status]) => status), ["Backlog", "Todo", "In Progress"]);
  assert.deepEqual(keys(flatten(groups[0][1])), ["NBF-2", "NBF-1", "NBF-3"], "priority 1 (urgent) before 3 (medium) before 0 (none)");
});

test("a ticket sits under its shown parent whatever its own status, and one whose parent is not shown stands in its own status", () => {
  const nested = [
    { ...t("NBF-1917", "In Progress", 2, 2, null, "Lint rules across the fleet"), parent: null },
    { ...t("NBF-1936", "Todo", 1, 2, null, "Shared config"), parent: "NBF-1917" },
    { ...t("NBF-1999", "Backlog", 0, 2, null, "A part of a part"), parent: "NBF-1936" },
    { ...t("VE-65", "Backlog", 0, 1, null, "Visual Explorer"), parent: "NBF-1917" },
    { ...t("VAL-11", "Backlog", 0, 2, null, "Validation"), parent: "NBF-1000" },
  ];
  const groups = groupByStatus(nested);
  assert.deepEqual(groups.map(([status, nodes]) => [status, nodes.map((n) => n.ticket.key)]), [["Backlog", ["VAL-11"]], ["In Progress", ["NBF-1917"]]],
    "only the tickets with no shown parent head a status");
  const [epic] = groups[1][1];
  assert.deepEqual(epic.children.map((n) => n.ticket.key), ["VE-65", "NBF-1936"], "children in the workflow's order, then by priority");
  assert.deepEqual(epic.children[1].children.map((n) => n.ticket.key), ["NBF-1999"], "a grandchild sits under its own parent");
  assert.deepEqual(keys(flatten(groups[1][1])), ["VE-65", "NBF-1999"], "a parent, at any depth, is not picked: the tickets under it are");
});

test("a tree counts every ticket in it and names every parent, at any depth", () => {
  const nested = [
    { ...t("NBF-1917", "In Progress", 2, 2, null), parent: null },
    { ...t("NBF-1936", "Todo", 1, 2, null), parent: "NBF-1917" },
    { ...t("NBF-1999", "Backlog", 0, 2, null), parent: "NBF-1936" },
    { ...t("VE-65", "Backlog", 0, 1, null), parent: "NBF-1917" },
    { ...t("NBF-1", "Backlog", 0, 2, null), parent: null },
  ];
  const heads = groupByStatus(nested).flatMap(([, nodes]) => nodes);
  assert.equal(ticketCount(heads), 5);
  assert.equal(ticketCount(heads.find((n) => n.ticket.key === "NBF-1917")!.children), 3, "the tickets under the epic, a grandchild among them");
  assert.deepEqual(parentKeys(heads), ["NBF-1917", "NBF-1936"], "a ticket with nothing under it is no parent");
});

test("a parent's checkbox takes the tickets under it that can still be picked, ticked when all are selected and part ticked when some are", () => {
  const nested = [
    { ...t("NBF-1917", "In Progress", 2, 2, null), parent: null },
    { ...t("NBF-1936", "Todo", 1, 2, null), parent: "NBF-1917" },
    { ...t("NBF-1999", "Backlog", 0, 2, null), parent: "NBF-1936" },
    { ...t("VE-65", "Backlog", 0, 1, null), parent: "NBF-1917" },
    { ...t("VE-66", "Backlog", 0, 1, null), parent: "NBF-1917" },
  ];
  const [[, [epic]]] = groupByStatus(nested);
  const queued: ViewEntry[] = [{ ticket: { key: "VE-66" }, phase: "queued" }];
  assert.deepEqual(parentTick(epic, new Set(), queued), { keys: ["VE-65", "NBF-1999"], checked: false, indeterminate: false },
    "a grandchild is under it, and a ticket on the queue already is not");
  assert.deepEqual(parentTick(epic, new Set(["VE-65"]), queued), { keys: ["VE-65", "NBF-1999"], checked: false, indeterminate: true });
  assert.deepEqual(parentTick(epic, new Set(["VE-65", "NBF-1999"]), queued), { keys: ["VE-65", "NBF-1999"], checked: true, indeterminate: false });
  const allQueued: ViewEntry[] = ["VE-65", "VE-66", "NBF-1999"].map((key) => ({ ticket: { key }, phase: "queued" }));
  assert.deepEqual(parentTick(epic, new Set(), allQueued), { keys: [], checked: false, indeterminate: false }, "nothing left to pick");
});

test("a parent that is not the person's heads its shown children in its own status, and is not one of the person's tickets", () => {
  const mine = [
    { ...t("VE-65", "Backlog", 0, 1, null), parent: "NBF-1917" },
    { ...t("NBF-1936", "In Progress", 2, 2, null), parent: "NBF-1917" },
    { ...t("NBF-1", "Backlog", 0, 2, null), parent: null },
  ];
  const parents = [
    { ...t("NBF-1917", "Todo", 1, 2, null, "Lint rules across the fleet"), parent: null },
    { ...t("NBF-1000", "Todo", 1, 2, null, "No shown child"), parent: null },
  ];
  const groups = groupByStatus(mine, parents);
  assert.deepEqual(groups.map(([status, nodes]) => [status, nodes.map((n) => `${n.ticket.key}${n.context ? " (context)" : ""}`)]),
    [["Backlog", ["NBF-1"]], ["Todo", ["NBF-1917 (context)"]]], "a parent with no shown child is left out");
  assert.deepEqual(groups[1][1][0].children.map((n) => n.ticket.key), ["VE-65", "NBF-1936"]);
  assert.deepEqual(keys(flatten(groups[1][1])), ["VE-65", "NBF-1936"], "the context parent cannot be picked");
  assert.deepEqual(groupByStatus(mine, [{ ...t("NBF-1", "Backlog", 0, 2, null), parent: null }]).flatMap(([, nodes]) => nodes.filter((n) => n.context)), [],
    "a parent that is the person's own is never a context node");
});

test("a ticket already on the queue cannot be selected again", () => {
  assert.equal(selectable(TICKETS[0], [{ ticket: { key: "NBF-1" }, phase: "queued" }]), false);
  assert.equal(selectable(TICKETS[1], [{ ticket: { key: "NBF-1" }, phase: "queued" }]), true);
});

test("toggling adds or removes a value and leaves the old set alone", () => {
  const before = new Set(["Backlog"]);
  assert.deepEqual([...toggled(before, "Todo")], ["Backlog", "Todo"]);
  assert.deepEqual([...toggled(before, "Backlog")], []);
  assert.deepEqual([...before], ["Backlog"]);
});

test("open sections and chosen projects are remembered, and a browser that refuses storage or holds junk gets the defaults", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (name: string) => kept.get(name) ?? null, setItem: (name: string, value: string) => { kept.set(name, value); } };
  remember(storage, "ticket-mode.open", new Set(["Backlog", "Todo"]));
  assert.deepEqual([...recall(storage, "ticket-mode.open")], ["Backlog", "Todo"]);
  const refusing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert.deepEqual([...recall(refusing, "x")], []);
  assert.doesNotThrow(() => remember(refusing, "x", new Set(["a"])));
  assert.deepEqual([...recall({ getItem: () => "{not json", setItem: () => {} }, "x")], []);
  assert.deepEqual([...recall(null, "x")], [], "no storage at all");
});

const run = (fields: Partial<ViewEntry>): ViewEntry => ({ ticket: { key: "NBF-1" }, phase: "finished", ...fields });

test("a live run is queued, in progress, or needs you while it waits on a person", () => {
  assert.equal(runStatus(run({ phase: "queued" })), "queued");
  assert.equal(runStatus(run({ phase: "starting" })), "working");
  assert.equal(runStatus(run({ phase: "running" })), "working");
  assert.equal(runStatus(run({ phase: "running", waiting: true })), "needs-you");
});

test("a finished run's outcome decides its status until the tracker settles the ticket", () => {
  assert.equal(runStatus(run({ outcome: { kind: "draft-pr" } })), "awaiting-review");
  for (const kind of ["needs-human", "wrong-repo", "no-outcome"]) assert.equal(runStatus(run({ outcome: { kind } })), "needs-you", kind);
  assert.equal(runStatus(run({ outcome: { kind: "crashed" } })), "failed");
  assert.equal(runStatus(run({ outcome: { kind: "stopped" } })), "cancelled");
  assert.equal(runStatus(run({ outcome: { kind: "draft-pr" }, trackerState: "started" })), "awaiting-review", "a ticket still open in the tracker");
});

test("a run that opened pull requests is settled by them once each has merged or closed, even while its ticket is in progress", () => {
  const prs = [{ url: "https://github.com/o/a/pull/1" }, { url: "https://github.com/o/b/pull/2" }];
  const settled = (states: Record<string, string>, trackerState = "started") => runStatus(run({ outcome: { kind: "draft-pr", prs }, pullStates: states, trackerState }));
  const [a, b] = prs.map(({ url }) => url);
  assert.equal(settled({ [a]: "merged", [b]: "merged" }), "completed");
  assert.equal(settled({ [a]: "merged", [b]: "open" }), "awaiting-review", "one still open");
  assert.equal(settled({ [a]: "merged" }), "awaiting-review", "one the tracker has not reported");
  assert.equal(settled({ [a]: "merged", [b]: "closed" }), "completed", "some of the work landed");
  assert.equal(settled({ [a]: "closed", [b]: "closed" }), "cancelled", "none of it landed");
  assert.equal(settled({ [a]: "merged", [b]: "merged" }, "canceled"), "cancelled", "the tracker's word still wins");
  assert.equal(runStatus(run({ outcome: { kind: "draft-pr", prs: [] }, pullStates: {} })), "awaiting-review", "a run with no pull requests is not settled by them");
});

test("the tracker's word wins once it settles the ticket: completed once its pull requests merged, cancelled once it was canceled", () => {
  assert.equal(runStatus(run({ outcome: { kind: "draft-pr" }, trackerState: "completed" })), "completed");
  assert.equal(runStatus(run({ outcome: { kind: "needs-human" }, trackerState: "completed" })), "completed", "a person finished it by hand");
  assert.equal(runStatus(run({ outcome: { kind: "draft-pr" }, trackerState: "canceled" })), "cancelled");
  assert.equal(runStatus(run({ outcome: { kind: "draft-pr" }, trackerState: "duplicate" })), "cancelled");
  assert.equal(runStatus(run({ phase: "running", trackerState: "completed" })), "working", "a live run is not settled by a stale reading");
});

test("every status is counted, a status with no runs at zero, and the filters list them in order", () => {
  const counts = statusCounts([run({ phase: "queued" }), run({ phase: "queued" }), run({ outcome: { kind: "crashed" } })]);
  assert.equal(counts.get("queued"), 2);
  assert.equal(counts.get("failed"), 1);
  assert.equal(counts.get("completed"), 0);
  assert.deepEqual(RUN_STATUSES.map(({ status }) => status), ["needs-you", "working", "blocked", "queued", "awaiting-review", "completed", "failed", "cancelled"]);
});

const blocker = (key: string, state: string, status = state) => ({ key, state, status });

test("a queued run is blocked until each ticket that blocks it is done in the tracker, or completed as a run on the queue", () => {
  const merged = "https://github.com/x/y/pull/1";
  const waiting = run({ ticket: { key: "APP-1" }, phase: "queued", blockers: [blocker("LIB-1", "started", "In Review"), blocker("LIB-2", "completed", "Done")] });
  const lib1 = run({ ticket: { key: "LIB-1" }, outcome: { kind: "draft-pr", prs: [{ url: merged }] }, pullStates: { [merged]: "open" } });
  assert.deepEqual(waitsOn(waiting, [waiting, lib1]), [blocker("LIB-1", "started", "In Review")], "LIB-2 is done in the tracker; LIB-1's pull request is open");
  assert.equal(runStatus(waiting, [waiting, lib1]), "blocked");
  const lib1Merged = { ...lib1, pullStates: { [merged]: "merged" } };
  assert.deepEqual(waitsOn(waiting, [waiting, lib1Merged]), [], "its run on the queue merged, though the tracker still has it in review");
  assert.equal(runStatus(waiting, [waiting, lib1Merged]), "queued");
  assert.deepEqual(waitsOn(waiting, [waiting]), [blocker("LIB-1", "started", "In Review")], "off the queue, only the tracker's word lets it go");
  assert.equal(runStatus(run({ phase: "queued" })), "queued", "a run with no blockers, or none read yet, is queued");
});

test("a canceled or duplicate blocker never lets a run go, and the run is counted as blocked", () => {
  const waiting = run({ ticket: { key: "APP-1" }, phase: "queued", blockers: [blocker("LIB-1", "canceled", "Canceled"), blocker("LIB-2", "duplicate", "Duplicate")] });
  assert.equal(waitsOn(waiting, [waiting]).length, 2, "the work it waited on will not come: a person decides");
  const merged = "https://github.com/x/y/pull/2";
  const lib = run({ ticket: { key: "LIB-3" }, outcome: { kind: "draft-pr", prs: [{ url: merged }] }, pullStates: { [merged]: "merged" } });
  const released = run({ ticket: { key: "APP-2" }, phase: "queued", blockers: [blocker("LIB-3", "started", "In Review")] });
  const counts = statusCounts([waiting, released, lib]);
  assert.deepEqual([counts.get("blocked"), counts.get("queued")], [1, 1], "APP-2's blocker merged on the queue, so it counts as queued");
  assert.deepEqual(runsShown([waiting], "blocked").map((e) => e.ticket.key), ["APP-1"]);
});

test("runs are listed most recently active first, and a filter keeps only its status", () => {
  const entries = [
    run({ ticket: { key: "OLD" }, phase: "queued", queuedAt: 1 }),
    run({ ticket: { key: "DONE" }, outcome: { kind: "draft-pr" }, queuedAt: 2, startedAt: 3, finishedAt: 9 }),
    run({ ticket: { key: "LIVE" }, phase: "running", queuedAt: 4, startedAt: 5 }),
  ];
  assert.deepEqual(runsShown(entries, null).map((e) => e.ticket.key), ["DONE", "LIVE", "OLD"]);
  assert.deepEqual(runsShown(entries, "queued").map((e) => e.ticket.key), ["OLD"]);
});

test("the Queue button says what it will do", () => {
  assert.equal(queueLabel(0), "Select tickets to queue");
  assert.equal(queueLabel(1), "Queue 1 ticket");
  assert.equal(queueLabel(3), "Queue 3 tickets");
});

test("a run offers what its state allows: Remove queued, Stop live, Close parked, Retry once closed, and nothing for a result", () => {
  const run = (phase: string, fields: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "NBF-1" }, phase, ...fields });
  const handedBack = { outcome: { kind: "needs-human" } };
  assert.deepEqual(runActions(run("queued")), ["remove"]);
  assert.deepEqual(runActions(run("starting")), ["stop"]);
  assert.deepEqual(runActions(run("running", { workspace: "w1", pane: "w1:p1" })), ["stop"]);
  assert.deepEqual(runActions(run("finished", { ...handedBack, workspace: "w1", pane: "w1:p1" })), ["close"], "its workspace is still open, so no retry yet");
  assert.deepEqual(runActions(run("finished", handedBack)), ["retry"]);
  assert.deepEqual(runActions(run("finished", { outcome: { kind: "draft-pr" } })), [], "a draft pull request is the result");
  assert.deepEqual(runActions(run("finished", { outcome: { kind: "crashed" }, trackerState: "completed" })), [], "a completed ticket is done");
});

test("a parked run is a finished one that kept its workspace, and every outcome that parks a run reads as Needs you", () => {
  assert.equal(isParked({ ticket: { key: "NBF-1" }, phase: "finished", workspace: "w1" }), true);
  assert.equal(isParked({ ticket: { key: "NBF-1" }, phase: "running", workspace: "w1" }), false, "a live run is not parked");
  assert.equal(isParked({ ticket: { key: "NBF-1" }, phase: "finished" }), false, "a closed run is not parked");
  for (const kind of HANDED_BACK) {
    assert.equal(runStatus({ ticket: { key: "NBF-1" }, phase: "finished", outcome: { kind } }), "needs-you", `${kind} parks the run, so the board must ask for a person`);
  }
});

test("a run's terminal link fills the machine's template with its workspace, pane and key, encoded, and there is none without both", () => {
  const live: ViewEntry = { ticket: { key: "NBF-1" }, phase: "running", workspace: "w3", pane: "w3:p1" };
  assert.equal(terminalLink("http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal", live), "http://127.0.0.1:7318/?ws=w3&pane=w3%3Ap1&view=terminal");
  assert.equal(terminalLink("http://h/{key}/{pane}/{pane}", live), "http://h/NBF-1/w3%3Ap1/w3%3Ap1", "every placeholder, each time it appears");
  assert.equal(terminalLink(null, live), null, "the machine serves no terminal");
  assert.equal(terminalLink("http://h/{pane}", { ...live, pane: undefined }), null, "a run still starting has no pane yet");
  assert.equal(terminalLink("http://h/{pane}", { ticket: { key: "NBF-1" }, phase: "finished" }), null, "a closed run has no terminal");
});
