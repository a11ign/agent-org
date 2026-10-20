// no-token: gh -- pure functions, and a fake storage
import { test } from "node:test";
import assert from "node:assert/strict";
import * as boardView_0 from "./board-view.ts";
import * as boardView_1 from "./board-view/settled-by-pulls.ts";
import { CONCLUDED, HANDED_BACK, NO_PROJECT, RUN_STATUSES, flatten, groupByStatus, parentKeys, parentTick, ticketCount, projectCounts, chosenProject, inProject, recall, remember, selectable, toggled, PRIORITY_NAMES, hasPlan, missingPlan, planChoiceOf, planCounts, priorityCounts, prioritiesOf, visibleTickets, workItems, childrenNote, isParentTicket, openChildCount, type ViewEntry, type ViewTicket } from "./board-view/view-ticket.ts";
import { overrideNote, START_ANYWAY_TITLE, rebaseNote, repoLabel, repoOf, hasEdit, isParked, queueLabel, batchChoice, batchNote, batchOverride, isDefaultBatch, workersLabel, runActions, runStatus, runsShown, shownStatus, statusCounts, terminalLink, waitsOn, waitNote, cutListNote, repoOfPull, stackedOn, stackNote, isBeingPublished, isWatched, publishable, publishLabel, publishNote, publishTerminalLink, unplannedCount, workingNote, footprintOf, overlapWait, pathsOverlap, resumesOnConflict, type ViewPublish } from "./board-view/settled-by-pulls.ts";
import { terminalOpenHref, runChoiceLabel, writerChoiceLabel, apiBase, chosenConnection, connectionLabel, safeHref, reviewLinesOf, unlistedPulls } from "./board-view.ts";
import { pullReviewText, type PullRead } from "./board-view/pull-review-state.ts";
import { REGION_EXEMPT } from "../pr-open-region.ts";
import { ACCEPTANCE_DIR } from "../acceptance-file.ts";
import { CHANGESET_SCAFFOLD, SCAFFOLD_DIRS } from "../scaffold-dirs.ts";

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
  assert.deepEqual(keys(visibleTickets(TICKETS)), ["NBF-1", "NBF-2", "NBF-3", "NBCA-4", "NBCA-5"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, { projects: new Set(["Billing"]) })), ["NBCA-4", "NBCA-5"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, { projects: new Set(["Billing", NO_PROJECT]) })), ["NBF-3", "NBCA-4", "NBCA-5"]);
});

test("the search narrows within the chosen projects, matching key, title or project, in any case", () => {
  assert.deepEqual(keys(visibleTickets(TICKETS, { projects: new Set(["Visual Explorer - GA"]), search: "  RACKS " })), ["NBF-2"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, { search: "nbca" })), ["NBCA-4", "NBCA-5"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, { projects: new Set(["Billing"]), search: "racks" })), [], "a search outside the chosen projects finds nothing");
});

// The NBL host file's pattern: create-ticket names a plan `<KEY>-0001-plan-<slug>.md`.
const PLAN = /-plan-[^/]*\.md$/;
const planned = (ticket: ViewTicket, ...uploads: string[]): ViewTicket => ({ ...ticket, uploads });
const PLANNED = [
  planned(t("NBF-1", "Backlog", 0, 3, "Visual Explorer - GA"), "NBF-1-0001-plan-fit-to-view.md", "NBF-1-adr-0001-zoom.md"),
  planned(t("NBF-2", "Backlog", 0, 1, "Visual Explorer - GA"), "NBF-2-adr-0001-explanation.md", "screenshot.png"),
  t("NBF-3", "Backlog", 0, 0, null),
];

test("a ticket has a plan when a file uploaded to it is named like one, and an ADR, a screenshot or no uploads at all is not one", () => {
  assert.deepEqual(PLANNED.map((x) => hasPlan(x, PLAN)), [true, false, false]);
});

test("the plan filter keeps the tickets with a plan, or those without, within the projects and search, and keeps all without a filter", () => {
  assert.deepEqual(keys(visibleTickets(PLANNED, { plan: { pattern: PLAN, choice: "with" } })), ["NBF-1"]);
  assert.deepEqual(keys(visibleTickets(PLANNED, { plan: { pattern: PLAN, choice: "without" } })), ["NBF-2", "NBF-3"]);
  assert.deepEqual(keys(visibleTickets(PLANNED, { projects: new Set([NO_PROJECT]), plan: { pattern: PLAN, choice: "without" } })), ["NBF-3"]);
  assert.deepEqual(keys(visibleTickets(PLANNED)), ["NBF-1", "NBF-2", "NBF-3"]);
});

// An epic with a plan, over a ticket with one and a ticket without; and an epic with none over a ticket without.
const EPICS = [
  planned(t("E-1", "Backlog", 0, 2, null), "E-1-0001-plan-epic.md"),
  { ...planned(t("E-2", "Backlog", 0, 2, null), "E-2-0001-plan-part.md"), parent: "E-1" },
  { ...t("E-3", "Backlog", 0, 2, null), parent: "E-1" },
  t("E-4", "Backlog", 0, 2, null),
  { ...t("E-5", "Backlog", 0, 2, null), parent: "E-4" },
];

test("an epic is never work for a worker: only the tickets under none count, and the filter keeps an epic only for a ticket it keeps under it", () => {
  assert.deepEqual(keys(workItems(EPICS)), ["E-2", "E-3", "E-5"]);
  assert.deepEqual(planCounts(EPICS, PLAN), { with: 1, without: 2 }, "an epic's own plan is not counted");
  assert.deepEqual(keys(visibleTickets(EPICS, { plan: { pattern: PLAN, choice: "with" } })), ["E-1", "E-2"], "E-4 has no plan and nothing under it does");
  assert.deepEqual(keys(visibleTickets(EPICS, { plan: { pattern: PLAN, choice: "without" } })), ["E-1", "E-3", "E-4", "E-5"],
    "E-1 has a plan but shows for E-3, so E-3 is not torn from its epic");
});

test("chosen priorities show only their tickets, several at once, and No priority is one of them", () => {
  assert.deepEqual(keys(visibleTickets(TICKETS, { priorities: new Set([1]) })), ["NBF-2"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, { priorities: new Set([1, 0]) })), ["NBF-2", "NBF-3", "NBCA-5"]);
  assert.deepEqual(keys(visibleTickets(TICKETS, { priorities: new Set([0]), projects: new Set(["Billing"]) })), ["NBCA-5"], "it narrows the other filters");
  assert.deepEqual(keys(visibleTickets(TICKETS, { priorities: new Set() })), keys(TICKETS), "none chosen shows every ticket");
});

test("a priority keeps the epic above a ticket it keeps, whatever the epic's own priority", () => {
  const tree = [t("P-1", "Backlog", 0, 4, null), { ...t("P-2", "Backlog", 0, 1, null), parent: "P-1" }, { ...t("P-3", "Backlog", 0, 3, null), parent: "P-1" }];
  assert.deepEqual(keys(visibleTickets(tree, { priorities: new Set([1]) })), ["P-1", "P-2"]);
  assert.deepEqual(keys(visibleTickets(tree, { priorities: new Set([4]) })), [], "the epic's own Low is not a ticket of that priority");
});

test("the plan and priority filters are met by one ticket together, so an epic is not kept for two tickets that each meet one", () => {
  const tree = [
    t("E", "Backlog", 0, 2, null),
    { ...planned(t("A", "Backlog", 0, 4, null), "A-0001-plan-a.md"), parent: "E" },
    { ...t("B", "Backlog", 0, 1, null), parent: "E" },
  ];
  assert.deepEqual(keys(visibleTickets(tree, { plan: { pattern: PLAN, choice: "with" }, priorities: new Set([1]) })), []);
  assert.deepEqual(keys(visibleTickets(tree, { plan: { pattern: PLAN, choice: "without" }, priorities: new Set([1]) })), ["E", "B"]);
});

test("the priority chips count the tickets a worker can be given, most urgent first and none last, and leave out a priority no ticket has", () => {
  assert.deepEqual(priorityCounts(TICKETS), [[1, 1], [2, 1], [3, 1], [0, 2]]);
  assert.deepEqual(priorityCounts([t("P-1", "Backlog", 0, 4, null), { ...t("P-2", "Backlog", 0, 1, null), parent: "P-1" }]), [[1, 1]], "an epic is not counted");
  assert.deepEqual([1, 2, 3, 4, 0].map((p) => PRIORITY_NAMES[p]), ["Urgent", "High", "Medium", "Low", "No priority"]);
});

test("the remembered priority filter reads back as numbers, and anything that is not a priority is dropped", () => {
  assert.deepEqual([...prioritiesOf(new Set(["1", "0", "9", "high", "", " "]))], [1, 0]);
});

test("the plan chips count the tickets with a plan and those without", () => {
  assert.deepEqual(planCounts(PLANNED, PLAN), { with: 1, without: 2 });
});

test("only a remembered with or without is a plan filter; anything else the browser holds is every ticket", () => {
  assert.equal(planChoiceOf(new Set(["with"])), "with");
  assert.equal(planChoiceOf(new Set(["without"])), "without");
  assert.equal(planChoiceOf(new Set(["null"])), null);
  assert.equal(planChoiceOf(new Set()), null);
});

test("a ticket with no plan says so, and says when its parent's plan is what a worker reads instead", () => {
  const epic = planned(t("NBF-10", "Backlog", 0, 2, null), "NBF-10-0001-plan-epic.md");
  const bare = { ...t("NBF-11", "Backlog", 0, 2, null), parent: "NBF-10" };
  const orphan = { ...t("NBF-12", "Backlog", 0, 2, null), parent: "NBF-3" };
  const known = [...PLANNED, epic, bare, orphan];
  assert.equal(missingPlan(PLANNED[0], PLAN, known), null, "it has its own");
  assert.deepEqual(missingPlan(bare, PLAN, known), { note: "No plan of its own. A worker reads its parent NBF-10's plan.", covered: true });
  assert.deepEqual(missingPlan(orphan, PLAN, known), { note: "No plan attached. Attach one before a worker starts this.", covered: false },
    "a parent with no plan covers nothing");
  assert.equal(missingPlan({ ...bare, parent: "NBF-99" }, PLAN, known)?.covered, false, "nor does a parent the board does not know");
});

test("project chips count their tickets, most first, then by name", () => {
  assert.deepEqual(projectCounts(TICKETS), [["Billing", 2], ["Visual Explorer - GA", 2], [NO_PROJECT, 1]]);
});

test("A11-123: the project shown is the remembered one while the list holds it, else the first project of the sidebar, else none", () => {
  const counts = projectCounts(TICKETS);
  assert.equal(chosenProject(counts, "Billing"), "Billing", "remembered and listed");
  assert.equal(chosenProject(counts, "Gone"), "Billing", "remembered but no open ticket is left in it: the first project");
  assert.equal(chosenProject(counts, null), "Billing", "nothing remembered: the first project, most tickets first");
  assert.equal(chosenProject([], "Billing"), null, "nothing listed: no project");
  assert.equal(chosenProject([], null), null);
});

test("A11-123: a project's tickets are those of its name, and none when no project is chosen", () => {
  assert.deepEqual(inProject(TICKETS, "Billing").map((x) => x.key), TICKETS.filter((x) => x.project === "Billing").map((x) => x.key));
  assert.deepEqual(inProject(TICKETS, NO_PROJECT).map((x) => x.key), TICKETS.filter((x) => x.project === null).map((x) => x.key), "a ticket with no project is in (no project)");
  assert.deepEqual(inProject(TICKETS, null), []);
});

test("A11-123: a priority chosen keeps its chip at 0 when no ticket a worker can be given has it, and the others stay as they were", () => {
  assert.deepEqual(priorityCounts(TICKETS, new Set([4])), [[1, 1], [2, 1], [3, 1], [4, 0], [0, 2]], "no ticket is Low, but the chosen Low reads 0 in its place");
  assert.deepEqual(priorityCounts(TICKETS, new Set([1])), priorityCounts(TICKETS), "a chosen priority that has tickets is as it was");
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

test("A11-76: a ticket the tracker says has open sub-issues is a parent: not selectable, not work, and counted; with none open it is ordinary again", () => {
  const epic = { ...TICKETS[0], children: ["NBF-2", "NBF-3"] };
  const settled = { ...TICKETS[0], children: [] };
  assert.equal(isParentTicket(epic), true);
  assert.equal(openChildCount(epic), 2);
  assert.equal(childrenNote(epic), "Parent · 2 open sub-issues");
  assert.equal(childrenNote({ ...epic, children: ["NBF-2"] }), "Parent · 1 open sub-issue");
  assert.equal(selectable(epic, []), false, "never picked, even with none of its sub-issues in the list");
  assert.deepEqual(workItems([epic, TICKETS[1]]).map((x) => x.key), [TICKETS[1].key]);
  assert.equal(isParentTicket(settled), false);
  assert.equal(selectable(settled, []), true);
  assert.equal(isParentTicket(TICKETS[1]), false, "a ticket read without sub-issues is ordinary");
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
  assert.deepEqual(RUN_STATUSES.map(({ status }) => status), ["needs-you", "working", "planning", "reviewing", "blocked", "queued", "awaiting-review", "ready-to-merge", "publishing", "published", "checked", "completed", "failed", "cancelled"]);
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

test("a batch runs on the default with the parts chosen for it in place, and keeps only the parts that differ from the default", () => {
  const defaults = { model: "sonnet", effort: "high" };
  assert.deepEqual(batchChoice(defaults, {}), defaults);
  assert.deepEqual(batchChoice(defaults, { model: "opus" }), { model: "opus", effort: "high" });
  assert.deepEqual(batchOverride(defaults, { model: "opus", effort: "high" }), { model: "opus" });
  assert.deepEqual(batchOverride(defaults, { model: "sonnet", effort: "high" }), {}, "a batch chosen back to the default is the default again");
  assert.deepEqual(batchOverride({ model: "opus", effort: "high" }, { model: "opus", effort: "max" }), { effort: "max" }, "a default that catches up drops that part");
});

test("the Pick footer says whether a batch runs on the default, and names the default when it does not", () => {
  const defaults = { model: "sonnet", effort: "high" };
  assert.equal(isDefaultBatch({}), true);
  assert.equal(isDefaultBatch({ effort: "max" }), false);
  assert.equal(batchNote(defaults, {}), "The default");
  assert.equal(batchNote(defaults, { effort: "max" }), "These tickets only. The default is sonnet at high effort");
});

test("the Queue button says what it will do", () => {
  assert.equal(workersLabel(1), "Up to 1 worker at once");
  assert.equal(workersLabel(3), "Up to 3 workers at once");
  assert.equal(queueLabel(0), "Select tickets to queue");
  assert.equal(queueLabel(1), "Queue 1 ticket");
  assert.equal(queueLabel(3), "Queue 3 tickets");
  assert.equal(queueLabel(3, 2), "Queue 3 tickets, planning 2 first");
  assert.equal(queueLabel(3, 3), "Queue 3 tickets, planning all first");
  assert.equal(queueLabel(1, 1), "Queue 1 ticket, planning it first");
});

test("a run offers what its state allows: Remove queued, Stop live, Close parked, Retry once closed, Approve for open pull requests, Dismiss once finished", () => {
  const run = (phase: string, fields: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "NBF-1" }, phase, ...fields });
  const handedBack = { outcome: { kind: "needs-human" } };
  assert.deepEqual(runActions(run("queued")), ["remove"]);
  assert.deepEqual(runActions(run("starting")), ["stop"]);
  assert.deepEqual(runActions(run("running", { workspace: "w1", pane: "w1:p1" })), ["stop"]);
  assert.deepEqual(runActions(run("finished", { ...handedBack, workspace: "w1", pane: "w1:p1" })), ["close", "dismiss"], "its workspace is still open, so no retry yet");
  assert.deepEqual(runActions(run("finished", handedBack)), ["retry", "dismiss"]);
  const open = "https://github.com/x/y/pull/1";
  const draft = { outcome: { kind: "draft-pr", prs: [{ url: open }] }, pullStates: { [open]: "open" } };
  assert.deepEqual(runActions(run("finished", draft)), ["approve", "dismiss"], "a draft pull request is the result: it is approved, not retried");
  assert.deepEqual(runActions(run("finished", { ...draft, outcome: { kind: "reviewed", prs: [{ url: open }] } })), ["respond", "dismiss"], "a reviewed one answers its feedback: its pull requests are ready already");
  assert.deepEqual(runActions(run("finished", { ...draft, pullStates: { [open]: "merged" } })), ["dismiss"], "merged pull requests are done");
  assert.deepEqual(runActions(run("finished", { ...draft, trackerState: "canceled" })), ["dismiss"], "a canceled ticket is done");
  assert.deepEqual(runActions(run("finished", { outcome: { kind: "crashed" }, trackerState: "completed" })), ["dismiss"], "a completed ticket is done");
});

test("a review run shows as Reviewing while it works, and its reviewed pull requests as Ready to merge until they merge", () => {
  const url = "https://github.com/x/y/pull/1";
  const review = [{ url }];
  assert.equal(runStatus(run({ phase: "running", review })), "reviewing");
  assert.equal(runStatus(run({ phase: "running", review, waiting: true })), "needs-you", "a dialog still needs the person");
  const reviewed = run({ outcome: { kind: "reviewed", prs: review }, pullStates: { [url]: "open" } });
  assert.equal(runStatus(reviewed), "ready-to-merge");
  assert.equal(runStatus({ ...reviewed, pullStates: { [url]: "merged" } }), "completed");
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

test("a run planning its ticket is Planning, with its own filter after In progress; one queued to be planned is Queued", () => {
  const plan = { model: "opus", effort: "max" };
  assert.equal(runStatus({ ticket: { key: "A" }, phase: "running", plan }), "planning");
  assert.equal(runStatus({ ticket: { key: "A" }, phase: "running", plan, waiting: true }), "needs-you", "a planning run waiting on a person needs you");
  assert.equal(runStatus({ ticket: { key: "A" }, phase: "queued", plan }), "queued");
  assert.equal(runStatus({ ticket: { key: "A" }, phase: "running" }), "working");
  const order = RUN_STATUSES.map(({ status }) => status);
  assert.equal(order.indexOf("planning"), order.indexOf("working") + 1);
});

test("the tickets to be planned first are those with no plan of their own", () => {
  const plan = /-plan-[^/]*\.md$/;
  const tickets = [{ ...t("A", "Backlog", 0, 2, null), uploads: ["A-0001-plan-x.md"] }, t("B", "Backlog", 0, 2, null), { ...t("C", "Backlog", 0, 2, null), uploads: ["screenshot.png"] }];
  assert.equal(unplannedCount(tickets, plan), 2);
});

test("a run's row names its model and effort, and a ticket still to be planned names its planning run's first", () => {
  assert.equal(runChoiceLabel({ ticket: { key: "A" }, phase: "queued", model: "sonnet", effort: "high" }), "sonnet/high");
  assert.equal(runChoiceLabel({ ticket: { key: "A" }, phase: "queued", model: "sonnet", effort: "high", plan: { model: "opus", effort: "max" } }), "plan on opus/max, then sonnet/high");
  assert.equal(runChoiceLabel({ ticket: { key: "A" }, phase: "running", model: "sonnet", effort: "high", planned: true }), "sonnet/high on an unattended plan");
});

test("a new-ticket run's card names the model and effort it ran on, and names none for a run queued before they were stamped", () => {
  assert.equal(writerChoiceLabel({ model: "sonnet", effort: "max" }), "sonnet/max");
  assert.equal(writerChoiceLabel({}), "");
  assert.equal(writerChoiceLabel({ model: "sonnet" }), "", "a half-stamped run names none either");
});

test("a blocker with an open pull request in the run's planned repository is stacked on, not waited for, and any other blocker still holds the run", () => {
  const draft = "https://github.com/acme/nbl-ui-netbox/pull/12";
  const elsewhere = "https://github.com/acme/nbl-ui-platform-libs/pull/7";
  const stackable = { key: "NBF-1", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: { [draft]: "open" } };
  const otherRepo = { key: "NBF-2", state: "started", status: "In Review", branch: "nbf-2", pulls: { [elsewhere]: "open" } };
  const merged = { key: "NBF-3", state: "started", status: "In Review", branch: "nbf-3", pulls: { "https://github.com/acme/nbl-ui-netbox/pull/13": "merged" } };
  const notStarted = { key: "NBF-4", state: "unstarted", status: "Todo", branch: "nbf-4", pulls: {} };
  const waiting = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", blockers: [stackable, otherRepo, merged, notStarted] });
  assert.deepEqual(stackedOn(waiting, [waiting]), [{ key: "NBF-1", url: draft, repo: "nbl-ui-netbox", branch: "nbf-1-fit", head: null }]);
  assert.deepEqual(waitsOn(waiting, [waiting]).map((b) => b.key), ["NBF-2", "NBF-3", "NBF-4"], "another repository's, a merged-only or no pull request still holds it");
  const onlyStackable = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", blockers: [stackable] });
  assert.equal(runStatus(onlyStackable, [onlyStackable]), "queued", "a run stacked on every blocker it has is ready to start");
  const unplanned = run({ ticket: { key: "NBF-9" }, phase: "queued", blockers: [stackable] });
  assert.deepEqual([stackedOn(unplanned, [unplanned]), runStatus(unplanned, [unplanned])], [[], "blocked"], "a run with no planned repository never stacks");
  for (const state of ["canceled", "duplicate"]) {
    const gone = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", blockers: [{ ...stackable, state }] });
    assert.deepEqual([stackedOn(gone, [gone]), runStatus(gone, [gone])], [[], "blocked"], `a ${state} blocker's work will not come`);
  }
  const { branch: _unknown, ...noBranch } = stackable;
  const unbranched = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", blockers: [noBranch] });
  assert.deepEqual([stackedOn(unbranched, [unbranched]), runStatus(unbranched, [unbranched])], [[], "blocked"], "a blocker whose branch is unknown cannot be built on");
  const finished = run({ ticket: { key: "NBF-9" }, phase: "finished", plannedRepo: "nbl-ui-netbox", blockers: [stackable] });
  assert.deepEqual(stackedOn(finished, [finished]), [], "a finished run is stacked on nothing any more");
  const done = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", blockers: [{ ...stackable, state: "completed" }] });
  assert.deepEqual(stackedOn(done, [done]), [], "a blocker that is done is not stacked on: there is nothing to wait for");
  assert.equal(stackNote(stackedOn(waiting, [waiting])), "Stacked on NBF-1 #12");
  assert.equal(stackNote([{ key: "NBF-1", url: `${draft}/`, repo: "nbl-ui-netbox", branch: "b", head: null }]), "Stacked on NBF-1 #12", "a URL with a trailing slash keeps its number");
});

test("A11-77: a blocker the planner said to wait on to merge is never stacked on, holds the run until its pull requests merge, then lets it go", () => {
  const draft = "https://github.com/acme/nbl-ui-netbox/pull/12";
  const other = "https://github.com/acme/nbl-ui-netbox/pull/13";
  const stackable = { key: "NBF-1", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: { [draft]: "open" } };
  const waiting = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", waitMerged: ["NBF-1"], blockers: [stackable] });
  assert.deepEqual(stackedOn(waiting, [waiting]), [], "its open pull request is not stacked on");
  assert.deepEqual(waitsOn(waiting, [waiting]).map((b) => b.key), ["NBF-1"]);
  assert.equal(runStatus(waiting, [waiting]), "blocked");
  assert.equal(waitNote(waiting, [waiting]), "Waits for NBF-1 to merge");
  const landed = { ...waiting, blockers: [{ ...stackable, pulls: { [draft]: "merged" } }] };
  assert.deepEqual(waitsOn(landed, [landed]), [], "its only pull request merged, though the tracker still has NBF-1 in review");
  assert.equal(runStatus(landed, [landed]), "queued", "the run starts once it has merged");
  assert.deepEqual(stackedOn(landed, [landed]), [], "and starts on the default branch: nothing to stack on, so the brief has no stack section");
  assert.equal(waitNote(landed, [landed]), null);
  const oneOpen = { ...waiting, blockers: [{ ...stackable, pulls: { [draft]: "merged", [other]: "open" } }] };
  assert.deepEqual(waitsOn(oneOpen, [oneOpen]).map((b) => b.key), ["NBF-1"], "one pull request merged and one still open holds the run");
  const closed = { ...waiting, blockers: [{ ...stackable, pulls: { [draft]: "closed" } }] };
  assert.deepEqual(waitsOn(closed, [closed]).map((b) => b.key), ["NBF-1"], "a pull request closed unmerged never lets it go");
  for (const state of ["canceled", "duplicate"]) {
    const gone = { ...waiting, blockers: [{ ...stackable, state, pulls: { [draft]: "merged" } }] };
    assert.equal(runStatus(gone, [gone]), "blocked", `a ${state} blocker never lets go, even with a merged pull request`);
  }
  const completed = { ...waiting, blockers: [{ ...stackable, state: "completed" }] };
  assert.equal(runStatus(completed, [completed]), "queued", "a blocker the tracker completed still lets go");
  const unmarked = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", blockers: [{ ...stackable, pulls: { [draft]: "merged" } }] });
  assert.deepEqual(waitsOn(unmarked, [unmarked]).map((b) => b.key), ["NBF-1"], "without the mark a merged pull request alone is no reason to start: the tracker decides, as before");
  const mixed = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", waitMerged: ["NBF-1"],
    blockers: [stackable, { key: "NBF-2", state: "started", status: "In Review", branch: "nbf-2", pulls: { [other]: "open" } }, { ...stackable, key: "NBF-3", branch: "nbf-3", pulls: {} }] });
  assert.deepEqual(stackedOn(mixed, [mixed]).map((b) => b.key), ["NBF-2"], "a blocker the planner did not mark is still stacked on");
  assert.deepEqual(waitsOn(mixed, [mixed]).map((b) => b.key), ["NBF-1", "NBF-3"], "and one with no open pull request still waits");
  assert.equal(waitNote(mixed, [mixed]), "Waits for NBF-1 to merge", "the note names only the blocker the planner marked");
});

test("A11-116: a run is planned for its planner's repository, else its project's, and a planner's null falls back to the project's", () => {
  assert.equal(repoOf({ plannedRepo: "control", projectRepo: "agent-org" }), "control", "the planner names another: it wins");
  assert.equal(repoOf({ plannedRepo: null, projectRepo: "agent-org" }), "agent-org", "the planner names none: the project's is the default");
  assert.equal(repoOf({ projectRepo: "agent-org" }), "agent-org", "a ticket planned alone has the project's");
  assert.equal(repoOf({ projectRepo: null }), null, "a project with no repository leaves the worker to choose");
  assert.equal(repoOf({}), null);
});

test("A11-116: a run's row names the repository it works in, from its worktrees, its planner, or its project, and the worker chooses only when none names one", () => {
  assert.equal(repoLabel({ ticket: { key: "A" }, phase: "running", repos: ["agent-org"], projectRepo: "control" }), "agent-org", "the worktrees it made say most");
  assert.equal(repoLabel({ ticket: { key: "A" }, phase: "queued", plannedRepo: "control", projectRepo: "agent-org" }), "control (planned)");
  assert.equal(repoLabel({ ticket: { key: "A" }, phase: "queued", plannedRepo: null, projectRepo: "agent-org" }), "agent-org (from its project)", "a planner's null is the project's");
  assert.equal(repoLabel({ ticket: { key: "A" }, phase: "queued", projectRepo: null }), "the worker chooses the repo", "a project with no repository");
  assert.equal(repoLabel({ ticket: { key: "A" }, phase: "finished" }), "choosing a repo");
});

// A11-125: a queued run whose plan could not be downloaded is Blocked and says why, and is only removed, as any queued run is.
test("A11-125: a queued run whose plan could not be downloaded is Blocked, says why, and offers only Remove", () => {
  const stuck = run({ ticket: { key: "NBF-9" }, phase: "queued", pathsFailure: "the attachment link is gone" });
  assert.equal(runStatus(stuck, [stuck]), "blocked");
  assert.equal(waitNote(stuck, [stuck]), "Waits: its plan could not be downloaded (the attachment link is gone); the board asks again on every pass");
  assert.deepEqual(runActions(stuck), ["remove"]);
  const free = run({ ticket: { key: "NBF-8" }, phase: "queued" });
  assert.equal(runStatus(free, [free]), "queued", "a run whose plan is not yet asked for is not blocked by it");
  assert.equal(waitNote(free, [free]), null);
});

// A11-125: a queued run Blocked on an overlap, and on no ticket, is offered Start anyway; a run started past its overlap says so on its row.
test("A11-125: a queued run Blocked on an overlap is offered Start anyway beside Remove, and says what it overlapped once started anyway", () => {
  const holder = run({ ticket: { key: "NBF-1" }, phase: "running", paths: ["nbl-ui-netbox:src/pool.ts"] });
  const waiting = run({ ticket: { key: "NBF-2" }, phase: "queued", paths: ["nbl-ui-netbox:src/"] });
  assert.equal(runStatus(waiting, [holder, waiting]), "blocked");
  assert.deepEqual(runActions(waiting, undefined, [holder, waiting]), ["start-anyway", "remove"]);
  assert.match(START_ANYWAY_TITLE, /^Start this run now, beside the run that holds a path it shares/);
  const onBlocker = run({ ticket: { key: "NBF-3" }, phase: "queued", paths: ["nbl-ui-netbox:src/"], blockers: [{ key: "NBF-1", state: "started", status: "In Progress", pulls: {} }] });
  assert.deepEqual(runActions(onBlocker, undefined, [holder, onBlocker]), ["remove"], "a run blocked by a ticket is not offered it");
  const unplanned = run({ ticket: { key: "NBF-4" }, phase: "queued", pathsFailure: "the link is gone" });
  assert.deepEqual(runActions(unplanned, undefined, [unplanned]), ["remove"], "nor a run whose plan could not be read");
  assert.equal(overrideNote(waiting), null, "a run not started anyway says nothing");
  const started = run({ ticket: { key: "NBF-2" }, phase: "running", overlapOverride: { holder: "NBF-1", pull: "12", path: "src/pool.ts", at: 5 } });
  assert.equal(overrideNote(started), "Started anyway: it overlapped NBF-1 #12 on src/pool.ts; a person overrode the wait");
  const unread = run({ ticket: { key: "NBF-5" }, phase: "running", overlapOverride: { holder: "NBF-1", pull: null, path: null, at: 5 } });
  assert.equal(overrideNote(unread), "Started anyway: it overlapped NBF-1 before its changed files were read; a person overrode the wait");
});

test("A11-116: a blocker whose branch is pushed stacks on it with no pull request, so the run starts before one exists", () => {
  const head = "a".repeat(40);
  const pushed = { key: "NBF-1", state: "started", status: "In Progress", branch: "nbf-1-fit", head, pulls: {} };
  const waiting = run({ ticket: { key: "NBF-9" }, phase: "queued", projectRepo: "agent-org", blockers: [pushed] });
  assert.deepEqual(stackedOn(waiting, [waiting]), [{ key: "NBF-1", url: null, repo: "agent-org", branch: "nbf-1-fit", head }]);
  assert.deepEqual(waitsOn(waiting, [waiting]), [], "its branch is pushed: nothing holds the run");
  assert.equal(runStatus(waiting, [waiting]), "queued");
  assert.equal(stackNote(stackedOn(waiting, [waiting])), "Stacked on NBF-1 (branch `nbf-1-fit`, no pull request yet)");
  const planned = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "agent-org", projectRepo: null, blockers: [pushed] });
  assert.equal(runStatus(planned, [planned]), "queued", "a planned repository is enough, with no project default");
});

test("A11-116: a blocker not pushed, canceled, or in a run with no repository holds the run, and the board says why", () => {
  const stackable = { key: "NBF-1", state: "started", status: "In Progress", branch: "nbf-1-fit", pulls: {} };
  const waitingFor = (blocker: object, fields: Partial<ViewEntry> = {}) => run({ ticket: { key: "NBF-9" }, phase: "queued", projectRepo: "agent-org", blockers: [blocker as never], ...fields });
  const notPushed = waitingFor(stackable);
  assert.equal(runStatus(notPushed, [notPushed]), "blocked");
  assert.equal(waitNote(notPushed, [notPushed]), "Waits for NBF-1 to push its branch");
  const canceled = waitingFor({ ...stackable, state: "canceled", head: "b".repeat(40) });
  assert.equal(runStatus(canceled, [canceled]), "blocked", "a canceled blocker never releases, even with its branch pushed");
  assert.equal(waitNote(canceled, [canceled]), "NBF-1 was canceled: a person decides");
  const duplicate = waitingFor({ ...stackable, state: "duplicate", head: "b".repeat(40) });
  assert.equal(waitNote(duplicate, [duplicate]), "NBF-1 was marked a duplicate: a person decides");
  const noRepo = waitingFor({ ...stackable, head: "b".repeat(40) }, { projectRepo: null });
  assert.equal(waitNote(noRepo, [noRepo]), "Waits for NBF-1: no repository is planned for this ticket, so it cannot stack");
  const merged = waitingFor({ ...stackable, pulls: { "https://github.com/acme/agent-org/pull/3": "merged" } });
  assert.equal(waitNote(merged, [merged]), "Waits for NBF-1 to complete in the tracker", "its pull requests merged: the tracker decides");
  const marked = waitingFor({ ...stackable, head: "b".repeat(40) }, { waitMerged: ["NBF-1"] });
  assert.deepEqual(stackedOn(marked, [marked]), [], "a blocker the planner said to wait on to merge is never stacked on, pushed or not");
  assert.equal(waitNote(marked, [marked]), "Waits for NBF-1 to merge");
});

test("A11-116: the board says when a stacked run's branch was rebased, will be, or could not be rebased", () => {
  const base = { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "1111111aaaaaaaa" };
  assert.equal(rebaseNote(run({ phase: "finished" })), null, "a run stacked on nothing says nothing");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: base })), null, "a base that has not moved says nothing");
  assert.equal(rebaseNote(run({ phase: "running", stackBase: { ...base, seen: "2222222bbbbbbbb" } })), "Will be rebased onto NBF-1 when the worker stops");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: { ...base, seen: "2222222bbbbbbbb" } })), null, "a finished run is rebased by the sweep, not noted");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: { ...base, sha: "2222222bbbbbbbb", rebased: { from: base.sha, to: "2222222bbbbbbbb", at: 1 } } })),
    "Rebased onto NBF-1 by agent-org (1111111 → 2222222)");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: { ...base, failed: { head: "2222222bbbbbbbb", reason: "conflicted in src/pool.ts" } } })),
    "Rebase onto NBF-1 conflicted in src/pool.ts: a person resolves it");
});

test("a pull request's repository is read from its GitHub URL, and anything else names none", () => {
  assert.equal(repoOfPull("https://github.com/acme/nbl-ui-netbox/pull/12"), "nbl-ui-netbox");
  assert.equal(repoOfPull("https://github.com/acme/nbl-ui-netbox/issues/12"), null);
  assert.equal(repoOfPull("https://gitlab.com/acme/nbl-ui-netbox/pull/12"), null);
});

const shipped = (fields: Partial<ViewEntry> = {}): ViewEntry =>
  ({ ticket: { key: "NBF-1" }, phase: "finished", outcome: { kind: "reviewed", prs: [{ url: "https://github.com/x/a/pull/1" }] }, ...fields });

test("a reviewed run is Published once a publish run posted it, and still Completed once its pull requests merge", () => {
  assert.equal(runStatus(shipped()), "ready-to-merge");
  assert.equal(runStatus(shipped({ published: { link: "https://slack/1" } })), "published");
  assert.equal(runStatus(shipped({ published: { link: null }, pullStates: { "https://github.com/x/a/pull/1": "merged" } })), "completed");
  assert.equal(runStatus(shipped({ handedBack: "keeps getting feedback" })), "needs-you", "the board stopped answering feedback on its own");
  assert.deepEqual(runActions(shipped()), ["respond", "dismiss"], "ready pull requests are answered, not approved again");
  assert.deepEqual(runActions(shipped({ published: { link: null } })), ["respond", "dismiss"]);
  assert.deepEqual(runActions(shipped({ handedBack: "keeps getting feedback" })), ["respond", "dismiss"], "a person's Respond to review lets the board carry on");
  assert.deepEqual(runActions(shipped({ outcome: { kind: "draft-pr", prs: [] } })), ["approve", "dismiss"], "Approve is for drafts");
});

test("only a run Ready to merge can be ticked for Publish: not one published, parked, awaiting review, or held by the publish run under way", () => {
  assert.equal(publishable(shipped()), true);
  assert.equal(publishable(shipped({ published: { link: null } })), false, "no double posting");
  assert.equal(publishable(shipped({ outcome: { kind: "draft-pr", prs: [] } })), false, "nothing reaches Slack before a person approved it");
  assert.equal(publishable(shipped({ workspace: "w1" })), false, "parked");
  assert.equal(publishable(shipped(), { keys: ["NBF-1"], phase: "running" }), false);
  assert.equal(publishable(shipped(), { keys: ["NBF-1"], phase: "finished", failure: "x" }), true, "a failed publish leaves it Ready to merge");
  assert.equal(publishLabel(2), "Publish selected (2)");
});

const publishRun = (fields: Partial<ViewPublish> = {}): ViewPublish => ({ keys: ["NBF-1"], phase: "running", ...fields });

test("the publish run still to finish is posting only the runs it names", () => {
  for (const phase of ["queued", "starting", "running"]) assert.equal(isBeingPublished(shipped(), publishRun({ phase })), true, phase);
  assert.equal(isBeingPublished(shipped(), publishRun({ phase: "finished" })), false, "a finished publish run posts nothing");
  assert.equal(isBeingPublished(shipped({ ticket: { key: "NBF-2" } }), publishRun()), false, "a run it does not name");
  assert.equal(isBeingPublished(shipped(), undefined), false, "no publish run");
});

test("a run Ready to merge is shown as Publishing while the publish run posts it, and is Ready to merge, Published or Completed by what happens next", () => {
  assert.equal(shownStatus(shipped(), publishRun({ phase: "queued" })), "publishing", "from the press, before it starts");
  assert.equal(shownStatus(shipped(), publishRun({ phase: "starting" })), "publishing");
  assert.equal(shownStatus(shipped(), publishRun()), "publishing");
  assert.equal(shownStatus(shipped(), publishRun({ keys: ["NBF-2"] })), "ready-to-merge", "a run it does not post is as it was");
  assert.equal(shownStatus(shipped(), undefined), "ready-to-merge");
  assert.equal(shownStatus(shipped(), publishRun({ phase: "finished", failure: "no channel" })), "ready-to-merge", "a failed publish run leaves it Ready to merge");
  const done = shipped({ published: { link: "https://slack/1" } });
  assert.equal(shownStatus(done, publishRun({ phase: "finished" })), "published", "a publish run that posted it");
  assert.equal(shownStatus(done, publishRun()), "published", "a run already Published is never Publishing");
  const merged = shipped({ pullStates: { "https://github.com/x/a/pull/1": "merged" } });
  assert.equal(shownStatus(merged, publishRun()), "completed", "its pull requests merging settles it, whatever the publish run is doing");
  assert.equal(shownStatus(shipped({ handedBack: "keeps getting feedback" }), publishRun()), "needs-you", "a run handed to a person is theirs");
  assert.equal(shownStatus(shipped({ trackerState: "completed" }), publishRun()), "completed", "the tracker's word wins");
});

test("only a run Ready to merge is shown as Publishing: a draft, a live run and a failed one keep their own status", () => {
  const publish = publishRun();
  assert.equal(shownStatus(shipped({ outcome: { kind: "draft-pr", prs: [] } }), publish), "awaiting-review");
  assert.equal(shownStatus(shipped({ phase: "running", review: [{ url: "https://github.com/x/a/pull/1" }] }), publish), "reviewing", "a review round on a run being published");
  assert.equal(shownStatus(shipped({ phase: "queued" }), publish), "queued");
  assert.equal(shownStatus(shipped({ outcome: { kind: "crashed" } }), publish), "failed");
});

test("the run's own status is Ready to merge while it is Publishing: the pool and what a run offers go by it", () => {
  assert.equal(runStatus(shipped()), "ready-to-merge");
  assert.deepEqual(runActions(shipped()), ["respond", "dismiss"]);
  assert.equal(isWatched(shipped()), true, "the board still watches its pull requests");
});

test("Publishing is counted and filtered like every status, and a run keeps its own status without the publish run", () => {
  const second = shipped({ ticket: { key: "NBF-2" } });
  const third = shipped({ ticket: { key: "NBF-3" } });
  const publish = publishRun({ keys: ["NBF-1", "NBF-2"] });
  const counts = statusCounts([shipped(), second, third], publish);
  assert.deepEqual([counts.get("publishing"), counts.get("ready-to-merge")], [2, 1]);
  assert.deepEqual(runsShown([shipped(), second, third], "publishing", publish).map((e) => e.ticket.key), ["NBF-1", "NBF-2"]);
  assert.deepEqual(runsShown([shipped(), second, third], "ready-to-merge", publish).map((e) => e.ticket.key), ["NBF-3"]);
  assert.deepEqual([statusCounts([shipped()]).get("publishing"), statusCounts([shipped()]).get("ready-to-merge")], [0, 1]);
  assert.deepEqual(runsShown([shipped()], "publishing").map((e) => e.ticket.key), []);
});

test("every run the publish run posts links its terminal, in the machine's template, filled with the publish run's workspace and pane", () => {
  const template = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal&key={key}";
  const publish = publishRun({ workspace: "w9", pane: "w9:p1" });
  assert.equal(publishTerminalLink(template, shipped(), publish), "http://127.0.0.1:7318/?ws=w9&pane=w9%3Ap1&view=terminal&key=NBF-1");
  assert.equal(publishTerminalLink(template, shipped({ ticket: { key: "NBF-2" } }), { ...publish, keys: ["NBF-1", "NBF-2"] }), "http://127.0.0.1:7318/?ws=w9&pane=w9%3Ap1&view=terminal&key=NBF-2", "each run's own key");
  assert.equal(publishTerminalLink(template, shipped({ ticket: { key: "NBF-2" } }), publish), null, "a run it does not post");
  assert.equal(publishTerminalLink(template, shipped({ published: { link: null } }), publish), null, "a run that does not show Publishing");
  assert.equal(publishTerminalLink(template, shipped({ phase: "running", review: [{ url: "https://github.com/x/a/pull/1" }] }), publish), null, "a review round has its own terminal");
  assert.equal(publishTerminalLink(template, shipped(), { ...publish, phase: "finished" }), null, "a publish run that ended");
  assert.equal(publishTerminalLink(template, shipped(), undefined), null, "no publish run");
  assert.equal(publishTerminalLink(null, shipped(), publish), null, "the machine serves no terminal");
  assert.equal(publishTerminalLink(template, shipped(), publishRun({ phase: "queued" })), null, "no pane until it starts");
  assert.equal(publishTerminalLink(template, shipped(), publishRun({ workspace: "w9" })), null, "a workspace without a pane");
});

test("A11-89: a run whose pull request conflicts is resumed when it is watched or parked on anything but a result, concluded or stopped run, with a pull request open", () => {
  const open = { url: "https://github.com/x/a/pull/1" };
  const parked = (outcome: Record<string, unknown>, fields: Partial<ViewEntry> = {}) => shipped({ outcome, review: [open], workspace: "w1", ...fields } as Partial<ViewEntry>);
  for (const outcome of [{ kind: "needs-human", reason: "which colour?" }, { kind: "wrong-repo", where: "netbox" }, { kind: "no-outcome" }, { kind: "crashed", reason: "gone" }]) {
    assert.equal(resumesOnConflict(parked(outcome)), true, `a parked ${outcome.kind} run`);
  }
  assert.equal(resumesOnConflict(parked({ kind: "needs-human", reason: "x" }, { workspace: undefined })), true, "a run that ended with its workspace closed");
  assert.equal(resumesOnConflict(shipped()), true, "a watched run");
  assert.equal(resumesOnConflict(parked({ kind: "stopped" })), false, "stopped is a person's act");
  assert.equal(resumesOnConflict(parked({ kind: "checked", reason: "nothing to do" })), false, "concluded");
  assert.equal(resumesOnConflict(parked({ kind: "planned" })), false, "a plan is concluded");
  assert.equal(resumesOnConflict(parked({ kind: "draft-pr", prs: [open] })), false, "a draft awaits a person's Approve");
  assert.equal(resumesOnConflict(parked({ kind: "needs-human", reason: "x" }, { trackerState: "completed" })), false, "the tracker completed the ticket");
  assert.equal(resumesOnConflict(parked({ kind: "needs-human", reason: "x" }, { trackerState: "canceled" })), false, "the tracker canceled the ticket");
  assert.equal(resumesOnConflict(parked({ kind: "needs-human", reason: "x" }, { pullStates: { [open.url]: "merged" } })), false, "its pull request merged");
  assert.equal(resumesOnConflict(parked({ kind: "needs-human", reason: "x" }, { pullStates: { [open.url]: "closed" } })), false, "its pull request closed");
  assert.equal(resumesOnConflict(parked({ kind: "needs-human", reason: "x" }, { review: [] })), false, "no pull request is open");
  assert.equal(resumesOnConflict({ ticket: { key: "NBF-1" }, phase: "running", review: [open] } as ViewEntry), false, "a live run is not finished");
});

test("the Board says a publish run is under way, or why it failed, and nothing once it published", () => {
  assert.equal(publishNote(undefined), null);
  assert.equal(publishNote({ keys: ["A", "B"], phase: "running" }), "Publishing 2 runs");
  assert.equal(publishNote({ keys: ["A"], phase: "finished", failure: "no channel" }), "Publishing 1 run failed: no channel");
  assert.equal(publishNote({ keys: ["A"], phase: "finished" }), null);
});

test("the board watches a run Ready to merge or Published with a pull request open, and no other", () => {
  assert.equal(isWatched(shipped()), true);
  assert.equal(isWatched(shipped({ published: { link: null } })), true);
  assert.equal(isWatched(shipped({ pullStates: { "https://github.com/x/a/pull/1": "closed" } })), false, "closed or merged pull requests are never watched");
  assert.equal(isWatched(shipped({ outcome: { kind: "draft-pr", prs: [{ url: "https://github.com/x/a/pull/1" }] } })), false, "awaiting a person's review");
  assert.equal(isWatched(shipped({ workspace: "w1" })), false, "parked");
  assert.equal(isWatched(shipped({ handedBack: "x" })), false, "handed to a person");
  assert.equal(isWatched(shipped({ outcome: { kind: "reviewed", prs: [] } })), false, "a run with no pull request has nothing to watch");
});

test("the connection shown is the one remembered while it is listed, this machine's otherwise, then the first, and every call goes under its prefix", () => {
  const connections = [{ name: "lab", kind: "https" as const }, { name: "work", kind: "local" as const }, { name: "personal", kind: "ssh" as const }];
  assert.deepEqual(chosenConnection(connections, "personal"), { name: "personal", kind: "ssh" });
  assert.deepEqual(chosenConnection(connections, "gone"), { name: "work", kind: "local" });
  assert.deepEqual(chosenConnection(connections, null), { name: "work", kind: "local" });
  assert.deepEqual(chosenConnection(connections.filter((c) => c.kind !== "local"), null), { name: "lab", kind: "https" }, "a machine with no instance of its own shows the first");
  assert.equal(chosenConnection([], null), null);
  assert.equal(apiBase(null), "");
  assert.equal(apiBase({ name: "work", kind: "local" }), "/c/work");
  assert.equal(apiBase({ name: "personal", kind: "ssh" }), "/c/personal");
  assert.equal(connectionLabel({ name: "work", kind: "local" }), "work (this machine)");
  assert.equal(connectionLabel({ name: "lab", kind: "https" }), "lab");
});

test("a link is kept only when it is an http or https address, so one a remote board sends can never run script in the page", () => {
  assert.equal(safeHref("https://linear.app/x/issue/NBF-1"), "https://linear.app/x/issue/NBF-1");
  assert.equal(safeHref("HTTP://127.0.0.1:7318/"), "HTTP://127.0.0.1:7318/");
  for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,x", "//evil.example", null, undefined, 7]) assert.equal(safeHref(bad), "", String(bad));
});

test("a ready pull request run is awaiting review with no Approve, watched while its pull requests are open; a draft run keeps its Approve", () => {
  const pr = { repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/1" };
  const ready = run({ outcome: { kind: "ready-pr", prs: [pr] } });
  assert.equal(runStatus(ready), "awaiting-review");
  assert.deepEqual(runActions(ready), ["dismiss"], "no Approve: the reviewer is the review");
  assert.equal(isWatched(ready), true, "its feedback is watched");
  assert.equal(isWatched(run({ outcome: { kind: "ready-pr", prs: [pr] }, pullStates: { [pr.url]: "closed" } })), false, "a closed one is not watched");
  const draft = run({ outcome: { kind: "draft-pr", prs: [pr] } });
  assert.deepEqual(runActions(draft), ["approve", "dismiss"], "POSITIVE CONTROL: a draft run is still approved");
  assert.equal(isWatched(draft), false);
});

test("a checked run is Checked, never Needs you: it finished with its reason, offers no Retry, and can be dismissed", () => {
  const checked = run({ outcome: { kind: "checked", reason: "the toast already shows on refresh" } as ViewEntry["outcome"] });
  assert.equal(runStatus(checked), "checked");
  assert.equal(HANDED_BACK.has("checked"), false, "nothing is asked of a person, so the pool does not park it");
  assert.deepEqual([...CONCLUDED], ["checked", "done", "planned"]);
  assert.equal(statusCounts([checked]).get("needs-you"), 0, "it is not counted in Needs you");
  assert.deepEqual(runsShown([checked], "checked").map((e) => e.ticket.key), ["NBF-1"]);
  assert.deepEqual(runActions(checked), ["dismiss"], "a second worker would check the same thing again, so it is not retried");
  assert.equal(runStatus({ ...checked, trackerState: "completed" }), "completed", "the tracker's word still wins");
  assert.equal(RUN_STATUSES.find(({ status }) => status === "checked")?.label, "Checked");
});

test("A11-91: a done run is Completed, never Needs you, offers no Retry, and the tracker's cancel still wins", () => {
  const done = run({ outcome: { kind: "done", reason: "every Done-when holds", evidence: ["npm test: 12 pass"] } as ViewEntry["outcome"] });
  assert.equal(runStatus(done), "completed");
  assert.equal(statusCounts([done]).get("needs-you"), 0, "it is not counted in Needs you");
  assert.deepEqual(runsShown([done], "completed").map((e) => e.ticket.key), ["NBF-1"]);
  assert.deepEqual(runActions(done), ["dismiss"], "the ticket is complete, so no worker is queued again");
  assert.equal(HANDED_BACK.has("done"), false, "nothing is asked of a person, so the pool does not park it");
  assert.equal(runStatus({ ...done, trackerState: "canceled" }), "cancelled", "a ticket the tracker canceled is cancelled, whatever the run ended in");
});

test("A11-91: a run holding a worker's proposed edit offers Apply and Discard, and its Dismiss says the proposal goes too", () => {
  const edit = { why: "the title says the wrong thing", title: "Right title", base: { title: "Wrong title", description: "" } };
  const proposed = run({ outcome: { kind: "checked", reason: "nothing to change", edit } as ViewEntry["outcome"] });
  assert.equal(hasEdit(proposed), true);
  assert.deepEqual(runActions(proposed), ["apply-edit", "discard-edit", "dismiss"]);
  const parked = run({ workspace: "w1", outcome: { kind: "needs-human", reason: "which title?", edit } as ViewEntry["outcome"] });
  assert.deepEqual(runActions(parked), ["close", "apply-edit", "discard-edit", "dismiss"], "a parked run that proposes an edit offers Apply too");
  const done = run({ outcome: { kind: "done", reason: "verified", evidence: ["e"], edit } as ViewEntry["outcome"] });
  assert.deepEqual(runActions(done), ["apply-edit", "discard-edit", "dismiss"], "a completed run's proposal is applied after completion");
  assert.equal(hasEdit(run({ outcome: { kind: "checked", reason: "r" } as ViewEntry["outcome"] })), false);
});

test("a finished run being published offers no Dismiss until the publish run has ended, and a queued or live run never offers it", () => {
  const publish: ViewPublish = { keys: ["NBF-1"], phase: "running" };
  assert.deepEqual(runActions(shipped(), publish), ["respond"], "the publish run is posting its pull requests");
  assert.deepEqual(runActions(shipped(), { ...publish, phase: "finished" }), ["respond", "dismiss"]);
  assert.deepEqual(runActions(shipped(), { ...publish, keys: ["NBF-2"] }), ["respond", "dismiss"], "another run's publish holds nothing here");
  assert.equal(runActions(run({ phase: "queued" })).includes("dismiss"), false);
  assert.equal(runActions(run({ phase: "running", workspace: "w1" })).includes("dismiss"), false);
});

test("A11-80: a running run whose worker wrote working is In progress, not Needs you, with its reason as its note, and stalled says so", () => {
  const working = { ticket: { key: "NBF-1" }, phase: "running", workspace: "w1", working: { reason: "the roll is still running" } } satisfies ViewEntry;
  assert.equal(runStatus(working), "working", "In progress");
  assert.equal(statusCounts([working]).get("needs-you"), 0);
  assert.equal(isParked(working), false, "it holds its workspace as a live run, not parked");
  assert.deepEqual(workingNote(working), { text: "the roll is still running", stalled: false });
  const stalled = { ...working, working: { reason: "the roll is still running", stalled: true } };
  assert.equal(runStatus(stalled), "working", "a stall is flagged, not a status change");
  assert.deepEqual(workingNote(stalled), { text: "Stalled: idle with no newer outcome since it said: the roll is still running", stalled: true });
  assert.equal(workingNote({ ticket: { key: "NBF-1" }, phase: "running" }), null);
  assert.equal(workingNote({ ...working, phase: "finished" }), null, "a finished run's note is its outcome's");
});

test("A11-85: a stall the pane's background work caused says so, with the reason the board gave, and an idle stall keeps its own words", () => {
  const working = { ticket: { key: "NBF-1" }, phase: "running", workspace: "w1", working: { reason: "the fleet patch runs detached", stalled: true, stallReason: "background work gone" } } satisfies ViewEntry;
  assert.deepEqual(workingNote(working), { text: "Stalled: background work gone since it said: the fleet patch runs detached", stalled: true }, "POSITIVE: the background stall says the work is gone");
  const idle = { ...working, working: { reason: "the fleet patch runs detached", stalled: true } };
  assert.deepEqual(workingNote(idle), { text: "Stalled: idle with no newer outcome since it said: the fleet patch runs detached", stalled: true }, "CONTROL: a stall with no reason keeps the idle words");
  const unstalled = { ...working, working: { reason: "the fleet patch runs detached", stallReason: "background work gone" } };
  assert.deepEqual(workingNote(unstalled), { text: "the fleet patch runs detached", stalled: false }, "CONTROL: a reason with no stall is only the note");
});

// A11-82: a queued run waits on a path another run holds in its repository.
const pulled = (url: string, repo = "agent-org") => ({ url, repo });
const holderOf = (key: string, patch: Partial<ViewEntry>): ViewEntry => ({ ticket: { key }, phase: "running", ...patch } as ViewEntry);
const waitingOn = (paths: string[], patch: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "APP-2" }, phase: "queued", paths, ...patch } as ViewEntry);
/** A finished run holding `path` while its pull request `url` is open (its files `pullFiles`), and a queued run waiting on `path`. */
const holdAndWait = (url: string, path: string, pullFiles: string[]) => ({
  hold: holderOf("APP-1", { phase: "finished", paths: [path], outcome: { kind: "draft-pr", prs: [pulled(url)] }, pullFiles: { [url]: pullFiles } }),
  wait: waitingOn([path]),
});

test("A11-82: paths overlap only in one repository: equal, or a directory that holds the other; sibling directories and other repositories do not", () => {
  assert.equal(pathsOverlap("agent-org:src/ticket-mode/pool.ts", "agent-org:src/ticket-mode/pool.ts"), true);
  const cases: [string, string, boolean, string?][] = [
    ["agent-org:src/ticket-mode/", "agent-org:src/ticket-mode/pool.ts", true, "a directory holds its file"],
    ["agent-org:src/ticket-mode/pool.ts", "agent-org:src/", true, "the directory holds the file on either side"],
    ["agent-org:src/", "agent-org:src/ticket-mode/", true, "one directory inside another"],
    ["agent-org:src/ticket-mode/", "agent-org:src/ticket-port/", false, "sibling directories"],
    ["agent-org:src/ticket-mode/pool", "agent-org:src/ticket-mode/pool.ts", false, "a name is not a prefix of another"],
    ["agent-org:src/ticket-mode/pool.ts", "agent-org:src/ticket-mode/pool.ts/", false, "a file is not a directory"],
    ["agent-org:src/a.ts", "nbl-ui-netbox:src/a.ts", false, "different repositories never overlap"],
    ["agent-org:src/ticket-mode/pool.ts", "nbl-ui-netbox:src/ticket-mode/pool.ts", false, "and only that repository"],
  ];
  for (const [a, b, overlap, why] of cases) assert.equal(pathsOverlap(a, b), overlap, why);
});

test("A11-117: a pull request whose file list was cut short holds only the files listed, so a run that touches none of them is not held", () => {
  const url = "https://github.com/a11ign/agent-org/pull/3";
  const cut = holderOf("APP-1", { phase: "finished", outcome: { kind: "draft-pr", prs: [pulled(url)] }, pullFiles: { [url]: ["src/a.ts", ""] } });
  assert.deepEqual(footprintOf(cut), ["agent-org:src/a.ts"], "the empty name is no file");
  const waiting = waitingOn(["agent-org:docs/unrelated.md"]);
  assert.equal(overlapWait(waiting, [cut, waiting]), null, "a path it was not listed in is not held: the files past the list are unknown, not untouched");
  assert.equal(cutListNote(waiting, [cut, waiting]), "APP-1 #3 lists only part of its changed files, so a clash in the rest shows only as a conflict on the pull request.");
  const overlapping = waitingOn(["agent-org:src/a.ts"]);
  assert.deepEqual(overlapWait(overlapping, [cut, overlapping]), { key: "APP-1", pull: "3", path: "src/a.ts" }, "a file it lists still holds the run");
  assert.equal(cutListNote(overlapping, [cut, overlapping]), cutListNote(waiting, [cut, waiting]), "the note is the same whatever the path");
  assert.equal(overlapWait(waitingOn(["nbl-ui-netbox:docs/unrelated.md"]), [cut]), null, "another repository is not");
  assert.equal(cutListNote(waitingOn(["nbl-ui-netbox:docs/unrelated.md"]), [cut]), null, "and its cut list is no note for that repository");
  assert.equal(cutListNote(waitingOn([]), [cut]), null, "a run with no paths declared has no note");
  assert.equal(cutListNote(waitingOn(["agent-org:.acceptance/admin~a11-2.md"]), [cut]), null, "a run whose paths are only scaffolding contests nothing, so it has no note");
  assert.equal(pathsOverlap("agent-org:", "agent-org:src/a.ts"), false, "an empty name is no path, so it overlaps nothing");
});

test("A11-117: a run's footprint and its hold leave out the scaffolding of .acceptance/ and .changeset/, in the plan and in its pull requests, and keep the source", () => {
  const url = "https://github.com/a11ign/agent-org/pull/4";
  const run = holderOf("APP-1", {
    phase: "finished",
    paths: ["agent-org:.acceptance/", "agent-org:.acceptance/admin~a11-1.md", "agent-org:.changeset/", "agent-org:.changeset/brave-fox.md", "agent-org:src/a.ts", "agent-org:docs/.acceptance/x.md"],
    outcome: { kind: "draft-pr", prs: [pulled(url)] }, pullFiles: { [url]: [".acceptance/admin~a11-1.md", ".changeset/brave-fox.md", "src/b.ts"] },
  });
  assert.deepEqual(footprintOf(run), ["agent-org:src/a.ts", "agent-org:docs/.acceptance/x.md", "agent-org:src/b.ts"], "only the scaffolding at the root is left out");
  const scaffoldOnly = waitingOn([".acceptance/", ".changeset/", ".acceptance/admin~a11-2.md", ".changeset/calm-owl.md"].map((path) => `agent-org:${path}`));
  assert.equal(overlapWait(scaffoldOnly, [run, scaffoldOnly]), null, "a run whose paths are only scaffolding is not held, though the other run holds the same directories");
  assert.equal(overlapWait(waitingOn(["agent-org:.acceptance/admin~a11-1.md"]), [run]), null, "a ticket's own file is not held, though the other run listed it");
  assert.equal(overlapWait(waitingOn(["agent-org:src/b.ts"]), [run])?.path, "src/b.ts", "a source file a pull request changes holds the run that touches it");
});

test("A11-117: the board and the Region read one list of scaffolding directories, and the Region still exempts each of them", () => {
  assert.deepEqual(SCAFFOLD_DIRS, [ACCEPTANCE_DIR, CHANGESET_SCAFFOLD], "the acceptance directory is the one the acceptance file lives in");
  assert.deepEqual(SCAFFOLD_DIRS.map((dir) => REGION_EXEMPT.some(({ entry }) => entry === dir)), [true, true], "dropping either from REGION_EXEMPT fails here");
});

test("A11-117: a shared file a run lists still holds the run beside it, and the note names that file", () => {
  const url = "https://github.com/a11ign/agent-org/pull/7";
  const live = holderOf("APP-1", { phase: "finished", paths: ["agent-org:eslint.config.ts"], outcome: { kind: "draft-pr", prs: [pulled(url)] }, pullFiles: { [url]: [] } });
  const waiting = waitingOn(["agent-org:eslint.config.ts"]);
  assert.equal(waitNote(waiting, [live, waiting]), "Waits on APP-1 #7: both touch eslint.config.ts");
  assert.equal(runStatus(waiting, [live, waiting]), "blocked");
});

test("A11-117: two tickets that each list .acceptance/, .changeset/ and eslint.config.ts are held only by the shared file, and the note names it", () => {
  const url = "https://github.com/a11ign/agent-org/pull/7";
  const paths = ["agent-org:.acceptance/", "agent-org:.changeset/", "agent-org:eslint.config.ts"];
  const live = holderOf("APP-1", { phase: "finished", paths, outcome: { kind: "draft-pr", prs: [pulled(url)] }, pullFiles: { [url]: [] } });
  const waiting = waitingOn(paths);
  assert.equal(waitNote(waiting, [live, waiting]), "Waits on APP-1 #7: both touch eslint.config.ts", "named as the shared file, never the directory");
  assert.equal(runStatus(waiting, [live, waiting]), "blocked");
  const unshared = waitingOn(["agent-org:.acceptance/", "agent-org:.changeset/", "agent-org:src/a.ts"]);
  assert.equal(waitNote(unshared, [live, unshared]), null, "the same directories and no shared file: it starts");
});

test("A11-82: a run's footprint is its plan's paths and the files each open pull request changes, in that pull request's repository", () => {
  const run = holderOf("APP-1", {
    phase: "finished", paths: ["agent-org:src/a.ts"], outcome: { kind: "draft-pr", prs: [pulled("https://github.com/a11ign/agent-org/pull/9"), pulled("https://github.com/a11ign/lab/pull/3", "lab")] },
    pullStates: {}, pullFiles: { "https://github.com/a11ign/agent-org/pull/9": ["src/b.ts"], "https://github.com/a11ign/lab/pull/3": ["x.ts"] },
  });
  assert.deepEqual(footprintOf(run), ["agent-org:src/a.ts", "agent-org:src/b.ts", "lab:x.ts"]);
  const merged = { ...run, pullStates: { "https://github.com/a11ign/agent-org/pull/9": "merged" as const } };
  assert.deepEqual(footprintOf(merged), ["agent-org:src/a.ts", "lab:x.ts"], "a merged pull request's files no longer count");
});

test("A11-82: a queued run waits on a path a live run holds in its repository, names it, and starts once nothing holds it", () => {
  const live = holderOf("APP-1", { phase: "running", paths: ["agent-org:src/ticket-mode/"] });
  const waiting = waitingOn(["agent-org:src/ticket-mode/pool.ts"]);
  assert.deepEqual(overlapWait(waiting, [live, waiting]), { key: "APP-1", pull: null, path: "src/ticket-mode/pool.ts" });
  assert.equal(runStatus(waiting, [live, waiting]), "blocked");
  assert.equal(waitNote(waiting, [live, waiting]), "Waits on APP-1: both touch src/ticket-mode/pool.ts");
  assert.equal(overlapWait(waiting, [waiting]), null, "a queued run holds nothing");
  assert.equal(runStatus(waiting, [waiting]), "queued");
  const other = waitingOn(["agent-org:src/ticket-port/a.ts"]);
  assert.equal(overlapWait(other, [live, other]), null, "a path it does not share does not wait");
});

test("A11-82: a finished run holds its footprint while its pull request is open, with the number the reason names, and frees it once the pull request merges", () => {
  const url = "https://github.com/a11ign/agent-org/pull/1736";
  const { hold: draft, wait: waiting } = holdAndWait(url, "agent-org:src/ticket-mode/pool.ts", []);
  assert.equal(waitNote(waiting, [draft, waiting]), "Waits on APP-1 #1736: both touch src/ticket-mode/pool.ts");
  const merged = { ...draft, pullStates: { [url]: "merged" as const } };
  assert.equal(overlapWait(waiting, [merged, waiting]), null);
  assert.equal(overlapWait(waiting, [{ ...draft, pullStates: { [url]: "closed" as const } }, waiting]), null, "closed unmerged frees it too");
  const feedbackOnly = holderOf("APP-3", { phase: "finished", paths: [], outcome: { kind: "checked" }, pullFiles: { [url]: ["src/ticket-mode/pool.ts"] } });
  assert.equal(overlapWait(waiting, [feedbackOnly, waiting]), null, "a finished run with no open pull request holds nothing");
});

test("A11-82: a run whose ticket ended holds nothing, and a queued review round holds the paths of the pull request it continues", () => {
  const url = "https://github.com/a11ign/agent-org/pull/2";
  const waiting = waitingOn(["agent-org:src/a.ts"]);
  const canceled = holderOf("APP-1", { phase: "finished", paths: ["agent-org:src/a.ts"], trackerState: "canceled", outcome: { kind: "draft-pr", prs: [pulled(url)] }, pullStates: {} });
  assert.equal(overlapWait(waiting, [canceled, waiting]), null, "a canceled ticket's run is done with its pull request, whatever GitHub says");
  const round = holderOf("APP-1", { phase: "queued", paths: ["agent-org:src/a.ts"], review: [pulled(url)] });
  assert.deepEqual(overlapWait(waiting, [round, waiting]), { key: "APP-1", pull: "2", path: "src/a.ts" }, "a queued review round still has its pull request open");
});

test("A11-82: a run is not held by its own blockers, by a run that is blocked by it, or by a review round, planning run or unread plan", () => {
  const live = holderOf("APP-1", { phase: "running", paths: ["agent-org:src/a.ts"] });
  const shared = ["agent-org:src/a.ts"];
  assert.equal(overlapWait(waitingOn(shared, { blockers: [{ key: "APP-1", state: "started", status: "In Progress", pulls: {} }] }), [live]), null, "its own blocker");
  assert.equal(overlapWait(waitingOn(shared), [holderOf("APP-1", { phase: "running", paths: shared, blockers: [{ key: "APP-2", state: "unstarted", status: "Todo", pulls: {} }] })]), null,
    "a run that is blocked by it");
  assert.equal(overlapWait(waitingOn(shared, { review: [pulled("https://github.com/a11ign/agent-org/pull/1")] }), [live]), null, "a review round is never held");
  assert.equal(overlapWait(waitingOn(shared, { plan: { model: "opus", effort: "max" } }), [live]), null, "a planning run is never held");
  assert.equal(overlapWait(waitingOn(undefined as unknown as string[]), [live]), null, "a run whose plan is not read yet is not held by a path");
  assert.equal(overlapWait(waitingOn([]), [live]), null, "a run whose plan declares no paths is not held by one");
  assert.equal(overlapWait(waitingOn(shared), [holderOf("APP-1", { phase: "queued", paths: shared })]), null, "a queued run holds nothing");
});

test("a run's terminal opens the page's worker link for its connection, with the plain address encoded in it, for a connection of any name", () => {
  const plain = "http://127.0.0.1:7318/?ws=w3&pane=w3%3Ap1&view=terminal";
  assert.equal(terminalOpenHref({ name: "work", kind: "local" }, plain), "/c/work/terminal?link=http%3A%2F%2F127.0.0.1%3A7318%2F%3Fws%3Dw3%26pane%3Dw3%253Ap1%26view%3Dterminal");
  assert.equal(terminalOpenHref({ name: "my box", kind: "ssh" }, plain).startsWith("/c/my%20box/terminal?link="), true);
});

/*
 * New tickets (A11-94, A11-124): the form and a run's controls, as the page draws them.
 */

test("a new-ticket request needs its text, and grill needs a terminal; the body carries only the choices made", () => {
  assert.deepEqual(boardView_0.writerStart({ request: "  ", mode: "quick" }, { grill: true }), { enabled: false, reason: "Write what the ticket is for, in plain words" });
  assert.deepEqual(boardView_0.writerStart({ request: "x", mode: "grill" }, { grill: false }), { enabled: false, reason: "Grill needs a terminal: name tickets.terminal in the host file" });
  assert.deepEqual(boardView_0.writerStart({ request: "x", mode: "grill" }, { grill: true }), { enabled: true, reason: null });
  assert.deepEqual(boardView_0.writerBody({ request: "  Show requests  ", mode: "quick", project: "", repo: "nbl-ui-netbox", goal: "Keep honest", priority: "high", parent: " " }),
    { request: "Show requests", mode: "quick", repo: "nbl-ui-netbox", goal: "Keep honest", priority: "high" });
});

test("the goals and projects the form offers are those the listed tickets carry, once each and sorted", () => {
  const tickets = [
    { ...ticketOf("A-1"), project: "Visual", labels: [{ name: "Keep honest", group: "Goal" }, { name: "Bucket: Board", group: "Bucket" }] },
    { ...ticketOf("A-2"), project: "Board", labels: [{ name: "Keep honest", group: "Goal" }, { name: "Speed", group: "Goal" }] },
    { ...ticketOf("A-3"), project: null },
  ];
  assert.deepEqual(boardView_0.goalNames(tickets), ["Keep honest", "Speed"]);
  assert.deepEqual(boardView_0.projectNames(tickets), ["Board", "Visual"]);
});

test("a run offers Stop while it is not finished, Dismiss once it is finished, and Open terminal while its agent works", () => {
  assert.deepEqual(boardView_0.writerRunActions({ phase: "running", workspace: "w1" }), { stop: true, dismiss: false, terminal: true });
  assert.deepEqual(boardView_0.writerRunActions({ phase: "queued" }), { stop: true, dismiss: false, terminal: false });
  assert.deepEqual(boardView_0.writerRunActions({ phase: "creating", workspace: "w1" }), { stop: true, dismiss: false, terminal: false }, "its tickets are being made: no agent to open");
  assert.deepEqual(boardView_0.writerRunActions({ phase: "finished", workspace: "w1" }), { stop: false, dismiss: true, terminal: false });
});

test("a run shows its status in the words the board uses, and the request's model and effort", () => {
  assert.deepEqual(Object.values(boardView_0.WRITER_STATUS_LABEL), ["Queued", "Writing", "Waiting for you", "Done", "Failed"]);
  assert.equal(boardView_0.writerChoiceLabel({ model: "opus", effort: "high" }), "opus/high");
  assert.equal(boardView_0.writerChoiceLabel({}), "", "a run queued before the choice was stamped names none");
});





/** A listed ticket with only the fields the Pick view reads, for the goal and project lists. */
function ticketOf(key: string) {
  return { key, title: key, status: "Backlog", statusOrder: 0, priority: 0, project: null };
}

test("A11-106: a finished run shows what its stacked pull requests need said of their bases, and no other run does", () => {
  const note = "Needs retarget: https://github.com/a11ign/agent-org/pull/1749 still targets nbf-1-fit, whose branch is gone: retarget it by hand";
  const finished = { ticket: { key: "NBF-2" }, phase: "finished", retargets: { "https://github.com/a11ign/agent-org/pull/1749": note } } as ViewEntry;
  assert.equal(boardView_1.retargetNote(finished), note);
  assert.equal(boardView_1.retargetNote({ ...finished, phase: "running" } as ViewEntry), null, "a running run says nothing of its bases");
  assert.equal(boardView_1.retargetNote({ ticket: { key: "NBF-3" }, phase: "finished" } as ViewEntry), null, "a run with no note says nothing");
  assert.equal(runStatus(finished), runStatus({ ticket: { key: "NBF-2" }, phase: "finished" } as ViewEntry), "the run's status does not change for the note");
});

/** A pull request's review as the pool read it, with its head at `h1` and nothing else set, unless `extra` says otherwise (A11-119). */
const read = (extra: Partial<PullRead> = {}): PullRead => ({ head: "91bf0677aaaa", settled: true, reviewing: false, verdict: null, earlier: null, refusal: null, unposted: null, ...extra });

test("A11-119: a pull request's review state reads as the board words it, for each state the pool can read", () => {
  const cases: [string, PullRead | null][] = [
    ["review state not read", null],
    ["awaiting review at 91bf0677", read()],
    ["reviewing", read({ reviewing: true })],
    ["changes requested at 68bd2e8d, new head 91bf0677 not yet reviewed", read({ earlier: { head: "68bd2e8daaaa", word: "changes requested" } })],
    ["changes requested at 91bf0677", read({ verdict: "changes requested" })],
    ["approved at 91bf0677", read({ verdict: "approved" })],
    ["dismissed at 91bf0677", read({ verdict: "dismissed" })],
    ["waiting for checks at 91bf0677", read({ settled: false })],
    ["not reviewed: no reviewer: its author is outside the org", read({ refusal: "no reviewer: its author is outside the org" })],
    ["awaiting review at 91bf0677", read({ earlier: { head: "68bd2e8daaaa", word: "approved" } })],
  ];
  for (const [text, state] of cases) assert.equal(pullReviewText(state), text);
});

test("A11-119: a verdict on the current head says so before a verdict on an earlier one, and a reviewer live beats both", () => {
  assert.equal(pullReviewText(read({ verdict: "approved", earlier: { head: "68bd2e8daaaa", word: "changes requested" } })), "approved at 91bf0677");
  assert.equal(pullReviewText(read({ reviewing: true, verdict: "changes requested" })), "reviewing");
});

test("A11-119: a run row names the review state of each open pull request the pool has read, and no other", () => {
  // A review run that ended needs-human keeps its pull requests in `review`, as `pullsOf` reads them for an outcome that is not a result.
  const entry = { outcome: { kind: "needs-human", reason: "which colour?" }, review: [{ url: "https://github.com/a11ign/control/pull/119" }, { url: "https://github.com/a11ign/control/pull/120" }],
    pullStates: { "https://github.com/a11ign/control/pull/120": "merged" } } as unknown as Parameters<typeof reviewLinesOf>[0];
  assert.deepEqual(reviewLinesOf(entry, { "https://github.com/a11ign/control/pull/119": "awaiting review at 91bf0677", "https://github.com/a11ign/control/pull/120": "approved at 1" }),
    ["a11ign/control #119: awaiting review at 91bf0677"], "the merged pull request is not open, and an unread one shows no line");
  assert.deepEqual(reviewLinesOf(entry, {}), [], "nothing is read yet: nothing is shown");
});

test("A11-119: the Pull requests section lists the pull requests the pool has read that no run lists, and none when every one belongs to a run", () => {
  const run = { outcome: { kind: "ready-pr", prs: [{ url: "https://github.com/a11ign/control/pull/119" }] } } as unknown as Parameters<typeof unlistedPulls>[0][number];
  const reviews = { "https://github.com/a11ign/control/pull/119": "reviewing", "https://github.com/a11ign/agent-org/pull/1800": "awaiting review at 91bf0677" };
  assert.deepEqual(unlistedPulls([run], reviews), [{ url: "https://github.com/a11ign/agent-org/pull/1800", label: "a11ign/agent-org #1800", text: "awaiting review at 91bf0677" }]);
  assert.deepEqual(unlistedPulls([run], { "https://github.com/a11ign/control/pull/119": "reviewing" }), [], "hidden when none is unlisted");
});

test("A11-134: a ticket the server says holds an open decision cannot be selected, and an ordinary one can", () => {
  const held = { ...TICKETS[0], needsDecision: { kind: "decision", reason: "held" } };
  assert.equal(selectable(held, []), false);
  assert.equal(selectable(TICKETS[0], []), true);
});
