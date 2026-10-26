// no-token: gh -- pure functions, and a fake storage
import { test } from "node:test";
import assert from "node:assert/strict";
import * as boardView_0 from "./board-view.ts";
import * as boardView_1 from "./board-view/pull-status-and-notes.ts";
import { CONCLUDED, HANDED_BACK, NO_PROJECT, RUN_STATUSES, flatten, groupByStatus, parentKeys, parentTick, ticketCount, projectCounts, chosenProject, inProject, recall, remember, selectable, toggled, PRIORITY_NAMES, hasPlan, missingPlan, planChoiceOf, planCounts, priorityCounts, prioritiesOf, visibleTickets, workItems, childrenNote, isParentTicket, openChildCount, type ViewEntry, type ViewTicket } from "./board-view/view-types-and-filters.ts";
import { cutListNote, footprintOf, overlapWait, pathsOverlap } from "./board-view/overlap-hold.ts";
import { overrideNote, START_ANYWAY_TITLE, rebaseNote, repoLabel, repoOf, hasEdit, isParked, queueLabel, batchChoice, batchNote, batchOverride, isDefaultBatch, workersLabel, runActions, runStatus, runsShown, shownStatus, statusCounts, terminalLink, waitsOn, waitNote, repoOfPull, stackedOn, stackNote, isBeingPublished, isWatched, publishable, publishLabel, publishNote, publishTerminalLink, unplannedCount, workingNote, resumesOnConflict, type ViewPublish } from "./board-view/pull-status-and-notes.ts";
import { settledByPulls } from "./board-view/pull-settled.ts";
import { isReadyToMerge, mergeWaitLine } from "./board-view/pull-readiness.ts";
import type { PullHead } from "./board-view/view-types-and-filters.ts";
import type { PullDeclared } from "./board-view/pull-declared.ts";
import { sharedRunNote, terminalTab } from "./board-view/run-terminal.ts";
import { clockOf } from "./board-view/update-banner.ts";
import { BACKGROUND_WAIT_MS } from "./board-view/wait-deadline.ts";
import { pullAnswer } from "./board-view/pull-answer.ts";
import { checkNote, reasonOf } from "./board-view/run-reason.ts";
import { diffLines, learnsFrom, learnsLine, REPLANNING_LINE, STALE_PLAN_LINE, ticketChangeOf } from "./board-view/ticket-change.ts";
import { terminalOpenHref, runChoiceLabel, writerChoiceLabel, apiBase, chosenConnection, connectionLabel, safeHref, reviewLinesOf, unlistedPulls, afterMergeChecks } from "./board-view.ts";
import { closeCheck, decideFollowUp, emptyChecks, seedChecks, type ChecksFile } from "./after-merge/checks.ts";
import { AWAITING_PERSON_LINE, claimWarning, publishingOffLine, pullReviewText, type PullRead, reviewerBanner, REVIEWER_OFF_BANNER, REVIEWER_OFF_LINE } from "./board-view/pull-review-state.ts";
import { REGION_EXEMPT } from "../pr-open-region.ts";
import { ACCEPTANCE_DIR } from "../acceptance-file.ts";
import { CHANGESET_SCAFFOLD, SCAFFOLD_DIRS } from "../scaffold-dirs.ts";

/** A pull request head the watch read as ready to merge: approved at it, no required check red or running (A11-179). */
const GREEN_HEAD: PullHead = { head: "1a2b3c4d5e6f", approved: true, review: "approved", red: [], pending: [] };

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

test("A11-144: a ticket another instance holds, shown with its state, cannot be selected", () => {
  assert.equal(selectable({ ...TICKETS[1], taken: "In Progress" }, []), false);
  assert.equal(selectable(TICKETS[1], []), true);
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
  assert.deepEqual(RUN_STATUSES.map(({ status }) => status), ["needs-you", "talking", "working", "waiting", "planning", "reviewing", "blocked", "queued", "awaiting-review", "not-merging", "ready-to-merge", "publishing", "published", "checked", "completed", "failed", "cancelled"]);
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
  assert.deepEqual(runActions(run("finished", handedBack)), ["retry", "talk", "dismiss"]);
  const open = "https://github.com/x/y/pull/1";
  const draft = { outcome: { kind: "draft-pr", prs: [{ url: open }] }, pullStates: { [open]: "open" } };
  assert.deepEqual(runActions(run("finished", draft)), ["approve", "talk", "dismiss"], "a draft pull request is the result: it is approved, not retried");
  assert.deepEqual(runActions(run("finished", { ...draft, outcome: { kind: "reviewed", prs: [{ url: open }] } })), ["respond", "talk", "dismiss"], "a reviewed one answers its feedback: its pull requests are ready already");
  assert.deepEqual(runActions(run("finished", { ...draft, pullStates: { [open]: "merged" } })), ["dismiss"], "merged pull requests are done");
  assert.deepEqual(runActions(run("finished", { ...draft, trackerState: "canceled" })), ["dismiss"], "a canceled ticket is done");
  assert.deepEqual(runActions(run("finished", { outcome: { kind: "crashed" }, trackerState: "completed" })), ["dismiss"], "a completed ticket is done");
});

test("a review run shows as Reviewing while it works, and its reviewed pull requests as Ready to merge until they merge", () => {
  const url = "https://github.com/x/y/pull/1";
  const review = [{ url }];
  assert.equal(runStatus(run({ phase: "running", review })), "reviewing");
  assert.equal(runStatus(run({ phase: "running", review, waiting: true })), "needs-you", "a dialog still needs the person");
  const reviewed = run({ outcome: { kind: "reviewed", prs: review }, pullStates: { [url]: "open" }, pullHeads: { [url]: GREEN_HEAD } });
  assert.equal(runStatus(reviewed), "ready-to-merge");
  assert.equal(runStatus({ ...reviewed, pullStates: { [url]: "merged" } }), "completed");
});

/** A reviewed run (A11-177's) on one open pull request, which the watch read as `head`: the card's status, its reason line and its outcome. */
function reviewedRun(head: Partial<PullHead> | null, fields: Partial<ViewEntry> = {}) {
  const url = "https://github.com/a11ign/a11ign/pull/5717";
  const entry = run({ outcome: { kind: "reviewed", prs: [{ repo: "a11ign", url }] }, pullStates: { [url]: "open" }, ...(head === null ? {} : { pullHeads: { [url]: { ...GREEN_HEAD, head: "58848c34a1b2", ...head } } }), ...fields });
  return { entry, url, status: runStatus(entry), line: reasonOf(entry).line, kind: entry.outcome?.kind };
}

test("A11-179: a reviewed run whose pull request has no approval at its head is Awaiting review, and says review: none yet, with its outcome still reviewed", () => {
  const unreviewed = reviewedRun({ approved: false, review: "none" });
  assert.deepEqual([unreviewed.status, unreviewed.line, unreviewed.kind], ["awaiting-review", "review: none yet at 58848c34", "reviewed"]);
  const changes = reviewedRun({ approved: false, review: "changes-requested" });
  assert.deepEqual([changes.status, changes.line], ["awaiting-review", "changes requested at 58848c34"]);
  assert.equal(publishable(unreviewed.entry), false, "a person cannot tick Publish on it");
  assert.equal(isWatched(unreviewed.entry), true, "and it is read again until it merges, or it could never become ready");
});

test("A11-179: a reviewed run whose pull request is approved but has a required check red is Awaiting review, and names the check", () => {
  const red = reviewedRun({ red: ["gate"] });
  assert.deepEqual([red.status, red.line, red.kind], ["awaiting-review", "checks red: gate", "reviewed"]);
  const both = reviewedRun({ approved: false, review: "none", red: ["gate", "refusalOwners"] });
  assert.equal(both.line, "review: none yet at 58848c34; checks red: gate, refusalOwners", "the review first, then the checks");
  const running = reviewedRun({ pending: ["gate", "suite"] });
  assert.deepEqual([running.status, running.line], ["awaiting-review", "checks not passed: gate, suite"], "a required check that has not concluded is not green");
  const all = reviewedRun({ review: "none", red: ["gate"], pending: ["suite"] });
  assert.equal(all.line, "review: none yet at 58848c34; checks red: gate; checks not passed: suite", "in the order review, red, running");
});

test("A11-179: a reviewed run whose pull request is approved at its head with every required check green is Ready to merge, with nothing it waits on", () => {
  const ready = reviewedRun({});
  assert.deepEqual([ready.status, ready.line, ready.kind, publishable(ready.entry), isReadyToMerge(ready.entry), mergeWaitLine(ready.entry)], ["ready-to-merge", null, "reviewed", true, true, null]);
});

test("A11-179: a pull request the watch has not read for readiness, or whose host does not say, is not proven ready: not read yet", () => {
  assert.deepEqual([reviewedRun(null).status, reviewedRun(null).line], ["awaiting-review", "not read yet"], "no watch has recorded a head");
  const url = reviewedRun(null).url;
  for (const [why, head] of [["a head recorded before readiness was read", { head: "h1", approved: true }], ["a host that does not say its checks", { head: "h1", approved: true, review: "approved", red: [] }],
    ["a host that does not say its review", { head: "h1", approved: true, red: [], pending: [] }]] as const) {
    const unread = run({ outcome: { kind: "reviewed", prs: [{ url }] }, pullStates: { [url]: "open" }, pullHeads: { [url]: head } });
    assert.deepEqual([runStatus(unread), reasonOf(unread).line], ["awaiting-review", "not read yet"], why);
  }
});

test("A11-179: every open pull request of a reviewed run has to be ready, and each is named by its address when more than one waits", () => {
  const [one, two] = ["https://github.com/a11ign/agent-org/pull/1", "https://github.com/a11ign/control/pull/2"];
  const both = (second: object) => run({ outcome: { kind: "reviewed", prs: [{ url: one }, { url: two }] }, pullStates: { [one]: "open", [two]: "open" }, pullHeads: { [one]: GREEN_HEAD, [two]: { ...GREEN_HEAD, ...second } } });
  assert.equal(runStatus(both({})), "ready-to-merge");
  assert.deepEqual([runStatus(both({ red: ["gate"] })), reasonOf(both({ red: ["gate"] })).line], ["awaiting-review", "a11ign/control #2: checks red: gate"], "one pull request that is not ready is enough");
  assert.equal(reasonOf(both({ review: "none", approved: false })).line, "a11ign/control #2: review: none yet at 1a2b3c4d");
  const merged = run({ outcome: { kind: "reviewed", prs: [{ url: one }, { url: two }] }, pullStates: { [one]: "open", [two]: "merged" }, pullHeads: { [one]: GREEN_HEAD } });
  assert.equal(runStatus(merged), "ready-to-merge", "a merged pull request is not waited for");
});

test("A11-179: a check red that the board named not this run's is marked so in the red clause, only at the head it was named for, and the card's note names where and who owns it", () => {
  const url = "https://github.com/a11ign/a11ign/pull/5717";
  const waiting = (checkHeads: ViewEntry["checkHeads"]) => reviewedRun({ approved: false, review: "none", red: ["gate", "refusalOwners"] }, { checkHeads }).entry;
  const named = waiting({ [url]: { head: "58848c34a1b2", step: "not-ours", note: "refusalOwners is red on main / not this run's; owned by A11-127", notOurs: { refusalOwners: "A11-127" } } });
  assert.equal(reasonOf(named).line, "review: none yet at 58848c34; checks red: gate, refusalOwners (not this run's)");
  assert.equal(checkNote(named), "refusalOwners is red on main / not this run's; owned by A11-127", "the note says where it is red and which ticket owns it");
  assert.equal(runStatus(named), "awaiting-review", "a red check that is not the run's still keeps the pull request from being ready: GitHub would not merge it");
  const stale = waiting({ [url]: { head: "0ld0ld0ld0ld", step: "not-ours", note: "x", notOurs: { refusalOwners: null } } });
  assert.equal(reasonOf(stale).line, "review: none yet at 58848c34; checks red: gate, refusalOwners", "a record made at another head marks nothing");
});

test("A11-179: only a reviewed run that is Awaiting review gets the clause line: a ready-pr run, a handed-back run and a Published one keep their own", () => {
  const url = "https://github.com/a11ign/a11ign/pull/5717";
  const unready = { approved: false, review: "none" as const };
  assert.equal(reasonOf(run({ outcome: { kind: "ready-pr", prs: [{ url }] }, pullStates: { [url]: "open" }, pullHeads: { [url]: { ...GREEN_HEAD, ...unready } } })).line, null);
  assert.equal(reasonOf(reviewedRun(unready, { handedBack: "keeps getting feedback" }).entry).line, "keeps getting feedback");
  const published = reviewedRun(unready, { published: { link: null } });
  assert.deepEqual([published.status, published.line], ["published", null], "a published run is as it was");
  assert.equal(reasonOf(reviewedRun(unready, { pullStates: { "https://github.com/a11ign/a11ign/pull/5717": "merged" } }).entry).line, "completed: a11ign/a11ign #5717 merged");
});

test("A11-153: a finished run whose pull requests have all merged is Completed, whatever kind its outcome was, and one whose all closed unmerged is Cancelled", () => {
  const url = "https://github.com/x/y/pull/1";
  const other = "https://github.com/x/y/pull/2";
  const review = [{ url }];
  for (const outcome of [{ kind: "needs-human", reason: "which colour?" }, { kind: "crashed", reason: "x" }, { kind: "stopped" }, { kind: "no-outcome" }, { kind: "wrong-repo", where: "a/b" }]) {
    const finished = run({ outcome, review, pullStates: { [url]: "open" } });
    assert.notEqual(runStatus(finished), "completed", `${outcome.kind}: open is not done`);
    assert.equal(runStatus({ ...finished, pullStates: { [url]: "merged" } }), "completed", `${outcome.kind}: merged is Completed`);
    assert.equal(runStatus({ ...finished, pullStates: { [url]: "closed" } }), "cancelled", `${outcome.kind}: closed unmerged is Cancelled`);
  }
  const pair = run({ outcome: { kind: "needs-human", reason: "q" }, review: [{ url }, { url: other }] });
  assert.equal(runStatus({ ...pair, pullStates: { [url]: "merged", [other]: "open" } }), "needs-you", "one still open keeps it open");
  assert.equal(runStatus({ ...pair, pullStates: { [url]: "merged", [other]: "closed" } }), "completed", "a merge and a close is Completed, as for a result");
  assert.equal(settledByPulls(run({ outcome: { kind: "needs-human", reason: "q" }, pullStates: { [url]: "merged" } })), null, "a pull request the ticket links but the run did not make is not its work");
  assert.equal(runStatus(run({ trackerState: "canceled", outcome: { kind: "needs-human", reason: "q" }, review, pullStates: { [url]: "merged" } })), "cancelled", "the tracker's word still comes first");
});

test("A11-153: a needs-human run reads its pull request's answer: approved at its head, or a head that is not the one it ended at, and nothing else", () => {
  const url = "https://github.com/x/y/pull/1";
  const other = "https://github.com/x/y/pull/2";
  const asked = run({ outcome: { kind: "needs-human", reason: "Does a copy run satisfy the done-when?" }, review: [{ url }], pullStates: { [url]: "open" }, outcomeHeads: { [url]: "h1" } });
  const heads = (head: string, approved = false) => ({ ...asked, pullHeads: { [url]: { head, approved } } });
  assert.equal(pullAnswer(asked), null, "no head read yet: nothing answers it");
  assert.equal(pullAnswer(heads("h1")), null, "the head it ended at, not approved");
  assert.equal(pullAnswer(heads("h2")), "answered");
  assert.equal(pullAnswer(heads("h1", true)), "approved", "an approval at the head, with no push");
  assert.equal(pullAnswer(heads("h2", true)), "approved", "approved wins over answered");
  assert.equal(pullAnswer({ ...heads("h2"), outcomeHeads: undefined }), null, "with no head it ended at there is nothing to compare");
  const two = { ...asked, review: [{ url }, { url: other }], pullStates: { [url]: "open", [other]: "open" }, outcomeHeads: { [url]: "h1", [other]: "k1" } };
  assert.equal(pullAnswer({ ...two, pullHeads: { [url]: { head: "h1", approved: true }, [other]: { head: "k1", approved: false } } }), null, "approved needs every open pull request");
  assert.equal(pullAnswer({ ...two, pullHeads: { [url]: { head: "h1", approved: true }, [other]: { head: "k2", approved: false } } }), "answered", "one pushed to is an answer");
  assert.equal(pullAnswer({ ...heads("h2"), pullStates: { [url]: "merged" } }), null, "a merged pull request is no open one");
  assert.equal(pullAnswer({ ...heads("h2"), outcome: { kind: "needs-human", reason: "the outcome file", unreadable: true } }), null, "a push does not fix an outcome file nobody could read");
  assert.equal(pullAnswer({ ...heads("h2"), outcome: { kind: "wrong-repo", where: "a/b" } }), null, "only needs-human is answered on its pull request");
  assert.equal(pullAnswer({ ...heads("h2"), phase: "running" }), null);
  assert.deepEqual([asked, heads("h1"), heads("h2"), heads("h1", true)].map((entry) => runStatus(entry)), ["needs-you", "needs-you", "awaiting-review", "awaiting-review"]);
});

test("A11-153: a card says Answered or Approved in place of the question, keeps the question one click away, and never says a note twice", () => {
  const url = "https://github.com/x/y/pull/1";
  const question = "Does a copy run satisfy the done-when?";
  const asked = run({ outcome: { kind: "needs-human", reason: question }, review: [{ url }], pullStates: { [url]: "open" }, outcomeHeads: { [url]: "h1" } });
  assert.deepEqual(reasonOf(asked), { line: question, question: null }, "unanswered, the question is the line");
  assert.deepEqual(reasonOf({ ...asked, pullHeads: { [url]: { head: "h2", approved: false } } }), { line: "Answered: awaiting review", question });
  assert.deepEqual(reasonOf({ ...asked, pullHeads: { [url]: { head: "h1", approved: true } } }), { line: "Approved", question });
  const note = "Resolving a conflict with A11-144 in doctor.ts";
  const stacked = { ...asked, stackBase: { key: "A11-144", repo: "agent-org", branch: "b", sha: "a".repeat(40), conflict: { head: "b".repeat(40), files: ["src/install/doctor.ts"] } } };
  assert.equal(rebaseNote(stacked), note);
  assert.deepEqual(reasonOf({ ...stacked, outcome: { kind: "needs-human", reason: note } }), { line: null, question: null }, "a reason that is the rebase note on the card is not said again");
  assert.deepEqual(reasonOf({ ...asked, retargets: { u: "retarget it" }, outcome: { kind: "needs-human", reason: "retarget it" } }), { line: null, question: null }, "nor a retarget note");
  assert.deepEqual(reasonOf({ ...asked, verdictNotPosted: "no verdict", outcome: { kind: "needs-human", reason: "no verdict" } }), { line: null, question: null }, "nor a verdict note");
  assert.deepEqual(reasonOf({ ...stacked, outcome: { kind: "needs-human", reason: note }, pullHeads: { [url]: { head: "h2", approved: false } } }),
    { line: "Answered: awaiting review", question: null }, "answered, the duplicate is not kept as the question either");
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
  assert.equal(order.indexOf("waiting"), order.indexOf("working") + 1);
  assert.equal(order.indexOf("planning"), order.indexOf("waiting") + 1);
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
  const waiting = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", blockers: [stackable, otherRepo, merged, notStarted], blockersDeclared: { "https://github.com/acme/nbl-ui-netbox/pull/13": { kind: "none" } } });
  assert.deepEqual(stackedOn(waiting, [waiting]), [{ key: "NBF-1", url: draft, repo: "nbl-ui-netbox", branch: "nbf-1-fit", head: null }]);
  assert.deepEqual(waitsOn(waiting, [waiting]).map((b) => b.key), ["NBF-2", "NBF-4"], "another repository's or no pull request still holds it; NBF-3's merged, so it holds nothing (A11-154)");
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
  const landed = { ...waiting, blockers: [{ ...stackable, pulls: { [draft]: "merged" } }], blockersDeclared: { [draft]: { kind: "none" } } } as ViewEntry;
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
  const unmarked = run({ ticket: { key: "NBF-9" }, phase: "queued", plannedRepo: "nbl-ui-netbox", blockers: [{ ...stackable, pulls: { [draft]: "merged" } }], blockersDeclared: { [draft]: { kind: "none" } } });
  assert.deepEqual(waitsOn(unmarked, [unmarked]), [], "marked or not, a merged pull request lets the run go, whatever state its ticket is in (A11-154)");
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
  const merged = waitingFor({ ...stackable, pulls: { "https://github.com/acme/agent-org/pull/3": "merged" } }, { blockersDeclared: { "https://github.com/acme/agent-org/pull/3": { kind: "none" } } });
  assert.equal(waitNote(merged, [merged]), null, "its pull requests merged: nothing holds the run, though the tracker has NBF-1 In Progress (A11-154)");
  const marked = waitingFor({ ...stackable, head: "b".repeat(40) }, { waitMerged: ["NBF-1"] });
  assert.deepEqual(stackedOn(marked, [marked]), [], "a blocker the planner said to wait on to merge is never stacked on, pushed or not");
  assert.equal(waitNote(marked, [marked]), "Waits for NBF-1 to merge");
});

test("A11-150: the board says when a stacked run's blocker branch was merged in, will be, or conflicts with it", () => {
  const base = { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "1111111aaaaaaaa" };
  assert.equal(rebaseNote(run({ phase: "finished" })), null, "a run stacked on nothing says nothing");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: base })), null, "a base that has not moved says nothing");
  assert.equal(rebaseNote(run({ phase: "running", stackBase: { ...base, seen: "2222222bbbbbbbb" } })), "Will have NBF-1 merged in when the worker stops");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: { ...base, seen: "2222222bbbbbbbb" } })), null, "a finished run is merged by the sweep, not noted");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: { ...base, sha: "2222222bbbbbbbb", merged: { from: base.sha, to: "2222222bbbbbbbb", at: 1 } } })),
    "Merged NBF-1 into the branch by agent-org (1111111 → 2222222)");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: { ...base, sha: "2222222bbbbbbbb", rebased: { from: base.sha, to: "2222222bbbbbbbb", at: 1 } } })),
    "Merged NBF-1 into the branch by agent-org (1111111 → 2222222)", "a record a rebase wrote reads as a merge");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: { ...base, conflict: { head: "2222222bbbbbbbb", files: ["src/pool.ts"] } } })),
    "Resolving a conflict with NBF-1 in pool.ts", "the conflict is named by its file, and the worker resolves it");
  assert.equal(rebaseNote(run({ phase: "running", stackBase: { ...base, conflict: { head: "2222222bbbbbbbb", files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"] } } })),
    "Resolving a conflict with NBF-1 in a.ts, b.ts, c.ts and 2 more", "three files are named, then how many more");
  assert.equal(rebaseNote(run({ phase: "finished", handedBack: "The pull requests keep getting feedback", stackBase: { ...base, conflict: { head: "2222222bbbbbbbb", files: ["src/pool.ts"], capped: 3 } } })),
    "The board's 3 rounds are used up before the merge with NBF-1 was resolved: Respond to review starts another", "the cap is named, not the conflict, while the run is handed back");
  assert.equal(rebaseNote(run({ phase: "finished", stackBase: { ...base, conflict: { head: "2222222bbbbbbbb", files: ["src/pool.ts"], capped: 3 } } })), null,
    "a parked run at the cap has no Respond to review to name");
});

test("a pull request's repository is read from its GitHub URL, and anything else names none", () => {
  assert.equal(repoOfPull("https://github.com/acme/nbl-ui-netbox/pull/12"), "nbl-ui-netbox");
  assert.equal(repoOfPull("https://github.com/acme/nbl-ui-netbox/issues/12"), null);
  assert.equal(repoOfPull("https://gitlab.com/acme/nbl-ui-netbox/pull/12"), null);
});

const shipped = (fields: Partial<ViewEntry> = {}): ViewEntry =>
  ({ ticket: { key: "NBF-1" }, phase: "finished", outcome: { kind: "reviewed", prs: [{ url: "https://github.com/x/a/pull/1" }] }, pullHeads: { "https://github.com/x/a/pull/1": GREEN_HEAD }, ...fields });

test("a reviewed run is Published once a publish run posted it, and still Completed once its pull requests merge", () => {
  assert.equal(runStatus(shipped()), "ready-to-merge");
  assert.equal(runStatus(shipped({ published: { link: "https://slack/1" } })), "published");
  assert.equal(runStatus(shipped({ published: { link: null }, pullStates: { "https://github.com/x/a/pull/1": "merged" } })), "completed");
  assert.equal(runStatus(shipped({ handedBack: "keeps getting feedback" })), "needs-you", "the board stopped answering feedback on its own");
  assert.deepEqual(runActions(shipped()), ["respond", "talk", "dismiss"], "ready pull requests are answered, not approved again");
  assert.deepEqual(runActions(shipped({ published: { link: null } })), ["respond", "talk", "dismiss"]);
  assert.deepEqual(runActions(shipped({ handedBack: "keeps getting feedback" })), ["respond", "talk", "dismiss"], "a person's Respond to review lets the board carry on");
  assert.deepEqual(runActions(shipped({ outcome: { kind: "draft-pr", prs: [] } })), ["approve", "talk", "dismiss"], "Approve is for drafts");
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
  assert.deepEqual(runActions(shipped()), ["respond", "talk", "dismiss"]);
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
  for (const outcome of [{ kind: "needs-human" }, { kind: "wrong-repo", where: "netbox" }, { kind: "no-outcome" }, { kind: "crashed" }]) {
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
  assert.deepEqual(runActions(ready), ["respond", "talk", "dismiss"], "no Approve: the reviewer is the review; Respond answers its pull request's feedback (A11-154)");
  assert.equal(isWatched(ready), true, "its feedback is watched");
  assert.equal(isWatched(run({ outcome: { kind: "ready-pr", prs: [pr] }, pullStates: { [pr.url]: "closed" } })), false, "a closed one is not watched");
  const draft = run({ outcome: { kind: "draft-pr", prs: [pr] } });
  assert.deepEqual(runActions(draft), ["approve", "talk", "dismiss"], "POSITIVE CONTROL: a draft run is still approved");
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
  assert.deepEqual(runActions(shipped(), publish), ["respond", "talk"], "the publish run is posting its pull requests");
  assert.deepEqual(runActions(shipped(), { ...publish, phase: "finished" }), ["respond", "talk", "dismiss"]);
  assert.deepEqual(runActions(shipped(), { ...publish, keys: ["NBF-2"] }), ["respond", "talk", "dismiss"], "another run's publish holds nothing here");
  assert.equal(runActions(run({ phase: "queued" })).includes("dismiss"), false);
  assert.equal(runActions(run({ phase: "running", workspace: "w1" })).includes("dismiss"), false);
});

test("A11-80: a running run whose worker wrote working is In progress, not Needs you, with its reason as its note, and stalled says so", () => {
  const working = { ticket: { key: "NBF-1" }, phase: "running", workspace: "w1", working: { reason: "the roll is still running" } } satisfies ViewEntry;
  assert.equal(runStatus(working), "working", "In progress");
  assert.equal(statusCounts([working]).get("needs-you"), 0);
  assert.equal(isParked(working), false, "it holds its workspace as a live run, not parked");
  assert.deepEqual(workingNote(working), { text: "the roll is still running", stalled: false, waiting: false });
  const stalled = { ...working, working: { reason: "the roll is still running", stalled: true } };
  assert.equal(runStatus(stalled), "working", "a stall is flagged, not a status change");
  assert.deepEqual(workingNote(stalled), { text: "Stalled: idle with no newer outcome since it said: the roll is still running", stalled: true, waiting: false });
  assert.equal(workingNote({ ticket: { key: "NBF-1" }, phase: "running" }), null);
  assert.equal(workingNote({ ...working, phase: "finished" }), null, "a finished run's note is its outcome's");
});

test("A11-85: a stall the pane's background work caused says so, with the reason the board gave, and an idle stall keeps its own words", () => {
  const working = { ticket: { key: "NBF-1" }, phase: "running", workspace: "w1", working: { reason: "the fleet patch runs detached", stalled: true, stallReason: "background work gone" } } satisfies ViewEntry;
  assert.deepEqual(workingNote(working), { text: "Stalled: background work gone since it said: the fleet patch runs detached", stalled: true, waiting: false }, "POSITIVE: the background stall says the work is gone");
  const idle = { ...working, working: { reason: "the fleet patch runs detached", stalled: true } };
  assert.deepEqual(workingNote(idle), { text: "Stalled: idle with no newer outcome since it said: the fleet patch runs detached", stalled: true, waiting: false }, "CONTROL: a stall with no reason keeps the idle words");
  const unstalled = { ...working, working: { reason: "the fleet patch runs detached", stallReason: "background work gone" } };
  assert.deepEqual(workingNote(unstalled), { text: "the fleet patch runs detached", stalled: false, waiting: false }, "CONTROL: a reason with no stall is only the note");
});

test("A11-236: a waiting run reads Waiting on background work, with how long when it is given the time, the job it named in place of its reason, and a stall past the bound names the job", () => {
  const run = (working: NonNullable<ViewEntry["working"]>): ViewEntry => ({ ticket: { key: "NBF-1" }, phase: "running", workspace: "w1", working });
  const waiting = run({ reason: "two shells run", at: 1000, waiting: true, waitingOn: "the fleet captures on three boxes" });
  const until = `, until ${clockOf(1000 + BACKGROUND_WAIT_MS)}`;
  assert.deepEqual(workingNote(waiting, 1000 + 54 * 60_000), { text: `Waiting on background work for 54 min: the fleet captures on three boxes${until}`, stalled: false, waiting: true });
  assert.equal(workingNote(waiting, 1000 + 88 * 60_000)?.text, `Waiting on background work for 1 h 28 min: the fleet captures on three boxes${until}`, "worded like the board's other durations");
  assert.equal(workingNote(waiting)?.text, `Waiting on background work: the fleet captures on three boxes${until}`, "without a time there is no duration");
  assert.equal(workingNote(run({ reason: "two shells run", at: 1000, waiting: true }), 1000 + 5 * 60_000)?.text, `Waiting on background work for 5 min: two shells run${until}`, "with no job named it quotes the reason");
  assert.equal(runStatus(waiting), "waiting", "the run is Waiting, not In progress (A11-272)");
  const stalled = run({ reason: "two shells run", at: 1000, stalled: true, stallReason: "waited past 2026-10-24T23:00:00.000Z on the fleet captures on three boxes" });
  assert.deepEqual(workingNote(stalled, 1e9), { text: "Stalled: waited past 2026-10-24T23:00:00.000Z on the fleet captures on three boxes since it said: two shells run", stalled: true, waiting: false });
  assert.equal(reasonOf(waiting, 1000 + 54 * 60_000).line, `Waiting on background work for 54 min: the fleet captures on three boxes${until}`, "the card's reason line carries it");
});

test("A11-245: a run that declared a wait reads exactly what the board last read of it, not Stalled, whatever the time; a stalled one names what it waited on", () => {
  const run = (working: NonNullable<ViewEntry["working"]>): ViewEntry => ({ ticket: { key: "NBF-1" }, phase: "running", workspace: "w1", working });
  const text = "Waiting on fleet job fj-1 (4 of 6 pages, about 20 min)";
  const waiting = run({ reason: "the capture runs on the fleet", at: 1000, waiting: true, waitText: text });
  const shown = `${text}, until ${clockOf(1000 + BACKGROUND_WAIT_MS)}`;
  assert.deepEqual(workingNote(waiting), { text: shown, stalled: false, waiting: true });
  assert.deepEqual(workingNote(waiting, 1000 + 5 * 60 * 60_000), { text: shown, stalled: false, waiting: true }, "the stored text is the card's: no duration is added from a clock, and the deadline is the one it was due at");
  assert.equal(reasonOf(waiting, 1000 + 54 * 60_000).line, shown, "the card's reason line carries it");
  assert.equal(runStatus(waiting), "waiting", "the run is Waiting, not In progress (A11-272)");
  const several = "Waiting on fleet job fj-1 (done); CI run a11ign/x#9 (running, 3 of 5 jobs)";
  assert.equal(workingNote(run({ reason: "r", at: 1000, waiting: true, waitText: several }))?.text, `${several}, until ${clockOf(1000 + BACKGROUND_WAIT_MS)}`, "several items are one line");
  const unreadable = "Waiting on fleet job fj-1 (could not read it: ssh: connection refused)";
  assert.equal(workingNote(run({ reason: "r", at: 1000, waiting: true, waitText: unreadable }))?.text, `${unreadable}, until ${clockOf(1000 + BACKGROUND_WAIT_MS)}`, "an unreadable item says so");
  const stalled = run({ reason: "the capture runs", at: 1000, stalled: true, waitText: text, stallReason: "waited past 2026-10-25T12:00:00.000Z on fleet job fj-1" });
  assert.deepEqual(workingNote(stalled), { text: "Stalled: waited past 2026-10-25T12:00:00.000Z on fleet job fj-1 since it said: the capture runs", stalled: true, waiting: false });
  assert.deepEqual(workingNote(run({ reason: "woken, nothing newer yet", at: 1000, waitText: text })), { text: "woken, nothing newer yet", stalled: false, waiting: false }, "a note that is not waiting reads as its reason, whatever text it holds");
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
  assert.deepEqual(overlapWait(overlapping, [cut, overlapping]), { key: "APP-1", pull: "3", path: "src/a.ts", overlaps: [{ path: "src/a.ts", folderOf: null, folder: null }] }, "a file it lists still holds the run");
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
  assert.deepEqual(overlapWait(waiting, [live, waiting]), { key: "APP-1", pull: null, path: "src/ticket-mode/pool.ts", overlaps: [{ path: "src/ticket-mode/pool.ts", folderOf: "APP-1", folder: "src/ticket-mode/" }] });
  assert.equal(runStatus(waiting, [live, waiting]), "blocked");
  assert.equal(waitNote(waiting, [live, waiting]), "Waits on APP-1: both touch src/ticket-mode/pool.ts; a folder claim, not a shared file: narrow APP-1's `src/ticket-mode/` in its plan");
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
  assert.deepEqual(overlapWait(waiting, [round, waiting]), { key: "APP-1", pull: "2", path: "src/a.ts", overlaps: [{ path: "src/a.ts", folderOf: null, folder: null }] }, "a queued review round still has its pull request open");
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

test("A11-199: the body names the placement when the form does: auto sends no choices, manual sends the ones made, and a form with none sends the choices alone", () => {
  const choices = { request: " Show requests ", mode: "quick", project: "Board", repo: "nbl-ui-netbox", goal: "", priority: "low", parent: " A11-12 " };
  assert.deepEqual(boardView_0.writerBody({ ...choices, placement: "auto" }), { request: "Show requests", mode: "quick", placement: "auto" }, "auto: the writer chooses, so no choice is sent");
  assert.deepEqual(boardView_0.writerBody({ ...choices, placement: "manual" }),
    { request: "Show requests", mode: "quick", placement: "manual", project: "Board", repo: "nbl-ui-netbox", priority: "low", parent: "A11-12" }, "manual: the choices made, as given");
  assert.deepEqual(boardView_0.writerBody({ request: "x", mode: "grill", placement: "manual" }), { request: "x", mode: "grill", placement: "manual" }, "manual with every choice left unset sends none");
  assert.equal("placement" in boardView_0.writerBody(choices), false, "a form that names no placement sends none, as before");
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
    ["re-review asked by reply at 91bf0677", read({ reviewing: true, verdict: "changes requested", rereview: true })],
  ];
  for (const [text, state] of cases) assert.equal(pullReviewText(state), text);
});

test("A11-156: a re-review a reply asked for is worded before the reviewer being live and before the block it answers, and says the claim it took over", () => {
  assert.equal(pullReviewText(read({ reviewing: true, verdict: "changes requested", rereview: true })), "re-review asked by reply at 91bf0677");
  assert.equal(pullReviewText(read({ reviewing: true, verdict: "changes requested", rereview: true, tookOver: "took over the claim of pool-a" })), "re-review asked by reply at 91bf0677 (took over the claim of pool-a)");
  assert.equal(pullReviewText(read({ verdict: "changes requested", rereview: false })), "changes requested at 91bf0677", "a re-review that has ended reads as the block that stands");
  assert.equal(pullReviewText(read({ reviewing: true, verdict: "approved" })), "reviewing", "an approval's reviewer still being open reads as it always did");
});

const FORBIDDEN = "gh: Resource not accessible by integration (HTTP 403)";

test("A11-172: a pull request whose claim cannot be written reads `cannot claim for review: <reason>`, ahead of a re-review's standing block, and a reviewer started without a claim says so", () => {
  const refused = { reason: FORBIDDEN, started: false };
  assert.equal(pullReviewText(read({ unclaimed: refused, refusal: "no reviewer for x: its claim could not be made" })), `cannot claim for review: ${FORBIDDEN}`);
  assert.equal(pullReviewText(read({ unclaimed: refused, verdict: "changes requested" })), `cannot claim for review: ${FORBIDDEN}`, "a re-review that cannot be claimed is seen under the block it answers");
  const alone = { reason: FORBIDDEN, started: true };
  assert.equal(pullReviewText(read({ unclaimed: alone, reviewing: true })), `reviewing without a claim: ${FORBIDDEN}`);
  assert.equal(pullReviewText(read({ unclaimed: alone, reviewing: false, verdict: "approved" })), "approved at 91bf0677", "once its verdict is posted the line is the verdict's");
  assert.equal(pullReviewText(read({ unclaimed: alone, reviewing: true, verdict: "changes requested", rereview: true })), `re-review asked by reply at 91bf0677 (reviewing without a claim: ${FORBIDDEN})`, "a re-review started without a claim says so too");
  assert.equal(pullReviewText(read({ reviewing: true })), "reviewing", "a claim that was written says nothing");
});

test("A11-172: one board warning covers every pull request that cannot be claimed, naming each reason once and counting the pull requests", () => {
  assert.equal(claimWarning([]), null);
  assert.equal(claimWarning([read(), read({ reviewing: true })]), null, "no claim problem, no warning");
  const refused = (reason: string) => read({ unclaimed: { reason, started: false } });
  assert.equal(claimWarning([refused(FORBIDDEN), refused(FORBIDDEN), refused(FORBIDDEN), read()]), `Reviews cannot be claimed on GitHub: ${FORBIDDEN} (3 pull requests). Run agent-org doctor.`);
  assert.equal(claimWarning([refused(FORBIDDEN)]), `Reviews cannot be claimed on GitHub: ${FORBIDDEN} (1 pull request). Run agent-org doctor.`);
  assert.equal(claimWarning([refused(FORBIDDEN), refused("gh: HTTP 502")]), `Reviews cannot be claimed on GitHub: ${FORBIDDEN}; gh: HTTP 502 (2 pull requests). Run agent-org doctor.`);
  const alone = read({ reviewing: true, unclaimed: { reason: FORBIDDEN, started: true } });
  assert.equal(claimWarning([alone, alone]), `Reviews start without a claim on GitHub: ${FORBIDDEN} (2 pull requests); no other instance is seen. Run agent-org doctor.`);
  assert.equal(claimWarning([alone, refused(FORBIDDEN)]), `Reviews cannot be claimed on GitHub: ${FORBIDDEN} (1 pull request). Reviews start without a claim on GitHub: ${FORBIDDEN} (1 pull request); no other instance is seen. Run agent-org doctor.`, "still one line when a second instance appears while one reviewer runs without a claim");
});

test("A11-119: a verdict on the current head says so before a verdict on an earlier one, and a reviewer live beats both", () => {
  assert.equal(pullReviewText(read({ verdict: "approved", earlier: { head: "68bd2e8daaaa", word: "changes requested" } })), "approved at 91bf0677");
  assert.equal(pullReviewText(read({ reviewing: true, verdict: "changes requested" })), "reviewing");
});

test("A11-119: a run row names the review state of each open pull request the pool has read, and no other", () => {
  // A review run that ended needs-human keeps its pull requests in `review`, as `pullsOf` reads them for an outcome that is not a result.
  const entry = { outcome: { kind: "needs-human" }, review: [{ url: "https://github.com/a11ign/control/pull/119" }, { url: "https://github.com/a11ign/control/pull/120" }],
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

test("a finished run offers Talk to it when it ended with something to say, and not when it concluded, was stopped, completed or canceled", () => {
  const done = (outcome: ViewEntry["outcome"], fields: Partial<ViewEntry> = {}) => runActions({ ticket: { key: "NBF-1" }, phase: "finished", outcome, ...fields });
  assert.ok(done({ kind: "needs-human" }).includes("talk"), "a question is answered in the run's own session");
  assert.ok(done({ kind: "crashed" }).includes("talk"));
  assert.ok(done({ kind: "draft-pr", prs: [] }).includes("talk"), "a draft a person has a problem with");
  for (const concluded of [{ kind: "checked" }, { kind: "done" }, { kind: "stopped" }] as ViewEntry["outcome"][]) {
    assert.equal(done(concluded).includes("talk"), false, `${concluded?.kind}: nothing to talk about`);
  }
  assert.equal(done({ kind: "needs-human" }, { trackerState: "canceled" }).includes("talk"), false, "a canceled ticket is done");
  assert.equal(done({ kind: "needs-human" }, { workspace: "w1", pane: "w1:p1" }).includes("talk"), false, "a parked run's terminal is open already: it is Close, not Talk");
  assert.equal(runActions({ ticket: { key: "NBF-1" }, phase: "running" }).includes("talk"), false, "a live run is answered where it is");
});

test("A11-149: a reviewer that took over an expired claim says so while it works, and says nothing of a head it did not take one on", () => {
  const took = "took over the claim of pool-a, 60 min old with no verdict";
  assert.equal(pullReviewText(read({ reviewing: true, tookOver: took })), `reviewing (${took})`);
  assert.equal(pullReviewText(read({ reviewing: true })), "reviewing");
});

const OPEN_PR = { repo: "agent-org", url: "https://github.com/a11ign/agent-org/pull/1802" };
/** A finished run whose pull request is open: a result kind lists it in its outcome, and any other kind (a round that ended needs-human or crashed) keeps it as the round's `review`. */
const withOpenPull = (fields: Partial<ViewEntry>): ViewEntry => run({ pullStates: { [OPEN_PR.url]: "open" }, review: [OPEN_PR], ...fields });

test("A11-154: a blocker lets go once its pull requests have merged, whatever state its ticket is in, and a canceled one never does", () => {
  const pulls = { "https://github.com/a11ign/agent-org/pull/1800": "merged" };
  const blocker = { key: "A11-144", state: "started", status: "In Progress", pulls };
  const waiting = (blockers: ViewEntry["blockers"], fields: Partial<ViewEntry> = {}) => run({ ticket: { key: "A11-145" }, phase: "queued", blockersDeclared: { [Object.keys(pulls)[0]]: { kind: "none" } }, ...fields, blockers });
  const started = waiting([blocker]);
  assert.deepEqual(waitsOn(started, [started]), [], "its pull request merged while its ticket is still In Progress (it said Refs)");
  assert.equal(runStatus(started, [started]), "queued");
  const marked = waiting([blocker], { waitMerged: ["A11-144"] });
  assert.deepEqual(waitsOn(marked, [marked]), [], "a blocker the planner marked to wait on lets go on its merge too");
  const withOpen = waiting([{ ...blocker, pulls: { ...pulls, "https://github.com/a11ign/agent-org/pull/1801": "open" } }]);
  assert.deepEqual(waitsOn(withOpen, [withOpen]).map((b) => b.key), ["A11-144"], "one merged and one still open holds the run");
  const noPull = waiting([{ ...blocker, pulls: {} }]);
  assert.deepEqual(waitsOn(noPull, [noPull]).map((b) => b.key), ["A11-144"], "no pull request is no merge");
  for (const state of ["canceled", "duplicate"]) {
    const gone = waiting([{ ...blocker, state }]);
    assert.deepEqual(waitsOn(gone, [gone]).map((b) => b.key), ["A11-144"], `a ${state} blocker never lets go, though its pull request merged`);
  }
  const stackable = waiting([{ ...blocker, branch: "a11-144-x", head: "b".repeat(40) }], { plannedRepo: "agent-org" });
  assert.deepEqual(stackedOn(stackable, [stackable]), [], "and the run is not stacked on a branch whose work is on the default branch");
});

const FLEET_PULL = "https://github.com/a11ign/screenreader-fleet/pull/71";
const CONTROL_PULL = "https://github.com/a11ign/control/pull/130";
/** A11-183 as the tracker gave it to A11-204 on 2026-10-24: In Progress, one pull request merged, its branch pushed. */
const A183 = { key: "A11-183", state: "started", status: "In Progress", branch: "a11-183-edge-pin", head: "c".repeat(40), pulls: { [FLEET_PULL]: "merged" } };
/** A11-204, queued behind A11-183 in the fleet repository, with A11-183's merged pull request read as declaring nothing. */
const behind183 = (fields: Partial<ViewEntry> = {}, blocker: object = A183) =>
  run({ ticket: { key: "A11-204" }, phase: "queued", plannedRepo: "screenreader-fleet", blockers: [blocker as never], blockersDeclared: { [FLEET_PULL]: { kind: "none" } }, ...fields });
const run183 = (fields: Partial<ViewEntry>): ViewEntry => run({ ticket: { key: "A11-183" }, ...fields });
const heldWords = (dependent: ViewEntry, blocker: ViewEntry): string[] => [runStatus(dependent, [dependent, blocker]), waitNote(dependent, [dependent, blocker]) ?? ""];

test("A11-206: a blocker whose ticket has a live run holds the run, whatever its pull requests so far did, and the card names where the run is", () => {
  const live: [string, ViewEntry, string][] = [
    ["running", run183({ phase: "running" }), "running"],
    ["starting", run183({ phase: "starting" }), "running"],
    ["queued", run183({ phase: "queued" }), "queued"],
    ["a planning run", run183({ phase: "running", plan: { model: "opus", effort: "max" } }), "planning"],
    ["a queued planning run", run183({ phase: "queued", plan: { model: "opus", effort: "max" } }), "planning"],
    ["a queued review round", run183({ phase: "queued", review: [{ url: FLEET_PULL }] }), "in a review round"],
    ["a running review round", run183({ phase: "running", review: [{ url: FLEET_PULL }] }), "in a review round"],
    ["an agent waiting on a dialog", run183({ phase: "running", waiting: true }), "waiting on a question"],
    ["a run parked on a question", run183({ phase: "finished", workspace: "w1", outcome: { kind: "needs-human", reason: "which?" } }), "waiting on a question"],
  ];
  for (const [name, blocker, word] of live) {
    const dependent = behind183();
    assert.deepEqual(waitsOn(dependent, [dependent, blocker]).map((b) => b.key), ["A11-183"], `${name}: holds although its only pull request merged`);
    assert.deepEqual(heldWords(dependent, blocker), ["blocked", `Waits for A11-183 (${word})`], name);
    assert.deepEqual(stackedOn(dependent, [dependent, blocker]), [], `${name}: a branch whose earlier pull request merged is not stacked on`);
  }
});

test("A11-206: a live run holds a blocker that is marked to wait for its merge, and the card says both", () => {
  const dependent = behind183({ waitMerged: ["A11-183"] });
  const blocker = run183({ phase: "running" });
  assert.equal(waitNote(dependent, [dependent, blocker]), "Waits for A11-183 (running) to merge");
  assert.equal(waitNote(behind183({ waitMerged: ["A11-183"], blockers: [{ ...A183, pulls: { [FLEET_PULL]: "open" } }] }), [blocker]), "Waits for A11-183 (running) to merge", "with its pull request open too");
});

test("A11-206: a blocker with a live run that has pushed its branch and no pull request is still stacked on, as before", () => {
  const dependent = behind183({}, { ...A183, pulls: {} });
  assert.deepEqual(stackedOn(dependent, [dependent, run183({ phase: "running" })]).map((base) => base.key), ["A11-183"]);
  assert.deepEqual(waitsOn(dependent, [dependent, run183({ phase: "running" })]), []);
});

test("A11-206: a Talk session is not a live run: it is judged by the finished run it resumes", () => {
  const finished = run183({ phase: "finished", outcome: { kind: "ready-pr", prs: [{ url: FLEET_PULL }] }, pullStates: { [FLEET_PULL]: "merged" } });
  const talking = run183({ phase: "running", talk: true, talkFrom: finished });
  const dependent = behind183();
  assert.deepEqual(waitsOn(dependent, [dependent, talking]), [], "a Talk session on a finished run whose pull requests merged: released (A11-154)");
  const queuedTalk = run183({ phase: "queued", talk: true, talkFrom: finished });
  assert.deepEqual(waitsOn(dependent, [dependent, queuedTalk]), [], "a queued one too");
  const parkedTalk = run183({ phase: "running", talk: true, talkFrom: { ...finished, workspace: "w1" } });
  assert.deepEqual(heldWords(dependent, parkedTalk), ["blocked", "Waits for A11-183 (waiting on a question)"], "the run it resumes is parked on a question: that holds");
  const midRound = run183({ phase: "running", talk: true, talkFrom: run183({ phase: "running" }) });
  assert.equal(waitsOn(dependent, [dependent, midRound]).length, 1, "a session over a run that is itself live holds");
});

test("A11-206: a blocker whose merged pull request declared Partial: holds, until a pull request that closes it merges or the ticket is Done", () => {
  const step = { kind: "partial", remains: "step 1 of 2: the control pull request" } as const;
  const holdingStep = behind183({ blockersDeclared: { [FLEET_PULL]: step } });
  assert.deepEqual(waitsOn(holdingStep, [holdingStep]).map((b) => b.key), ["A11-183"], "no live run, the ticket In Progress, one pull request merged and partial");
  assert.deepEqual(heldWords(holdingStep, run183({ phase: "finished" })), ["blocked", "Waits for A11-183 (step 1 of 2 merged)"]);
  assert.equal(waitNote(behind183({ blockersDeclared: { [FLEET_PULL]: { kind: "partial", remains: "the control pull request" } } }), []), "Waits for A11-183 (its last merged pull request is partial)", "a Partial: line that names no step");
  const withClosing = behind183({ blockersDeclared: { [FLEET_PULL]: step, [CONTROL_PULL]: { kind: "closes" } } }, { ...A183, pulls: { [FLEET_PULL]: "merged", [CONTROL_PULL]: "merged" } });
  assert.deepEqual(waitsOn(withClosing, [withClosing]), [], "a later pull request with the closing keyword merged: released");
  const done = behind183({ blockersDeclared: { [FLEET_PULL]: step } }, { ...A183, state: "completed" });
  assert.deepEqual(waitsOn(done, [done]), [], "the ticket is Done: released");
  const stillOpen = behind183({ blockersDeclared: { [FLEET_PULL]: step } }, { ...A183, branch: undefined, pulls: { [FLEET_PULL]: "merged", [CONTROL_PULL]: "open" } });
  assert.deepEqual(waitsOn(stillOpen, [stillOpen]).map((b) => b.key), ["A11-183"], "the next step's pull request is open: still holds, as before");
  const stacked = behind183({ blockersDeclared: { [FLEET_PULL]: step } }, { ...A183, pulls: { [FLEET_PULL]: "merged", [CONTROL_PULL]: "open" } });
  assert.deepEqual(stackedOn(stacked, [stacked]).map((base) => base.key), ["A11-183"], "and with its branch pushed it is stacked on, as A11-116 has it");
});

test("A11-206: a blocker's own finished run that declared Partial: and merged holds without any pull request body read, and releases once it closes or its ticket is Done", () => {
  const stalled = run183({ phase: "finished", partial: "step 1 of 2: the control pull request", outcome: { kind: "ready-pr", prs: [{ url: FLEET_PULL }] }, pullStates: { [FLEET_PULL]: "merged" } });
  const unread = behind183({ blockersDeclared: undefined });
  assert.equal(runStatus(stalled), "needs-you", "the board shows that run as Needs you");
  assert.deepEqual(heldWords(unread, stalled), ["blocked", "Waits for A11-183 (step 1 of 2 merged)"], "before the sweep read a body");
  const read = behind183();
  assert.equal(waitsOn(read, [read, stalled]).length, 1, "and when the body read says nothing that overrules it");
  const { partial: _dropped, ...closed } = stalled;
  assert.deepEqual(waitsOn(read, [read, closed]), [], "the run's own `Closes` merged: released");
  const completed = behind183({}, { ...A183, state: "completed" });
  assert.deepEqual(waitsOn(completed, [completed, stalled]), [], "Done");
});

test("A11-206: no live run and every pull request merged and read as complete: released even with the ticket In Progress (A11-154 stays)", () => {
  const dependent = behind183();
  assert.deepEqual(waitsOn(dependent, [dependent]), [], "a blocker the board holds no run for");
  assert.equal(runStatus(dependent, [dependent]), "queued");
  assert.equal(waitNote(dependent, [dependent]), null);
  const ended = run183({ phase: "finished", outcome: { kind: "ready-pr", prs: [{ url: FLEET_PULL }] }, pullStates: { [FLEET_PULL]: "merged" } });
  assert.deepEqual(waitsOn(dependent, [dependent, ended]), [], "a blocker whose finished run is Completed");
  const refs = run183({ phase: "finished", outcome: { kind: "needs-human", reason: "x" }, pullStates: {} });
  assert.deepEqual(waitsOn(dependent, [dependent, refs]), [], "a finished run that is not parked and whose ticket the tracker left In Progress holds nothing, as before");
  const withOpen = behind183({}, { ...A183, pulls: { [FLEET_PULL]: "merged", [CONTROL_PULL]: "open" }, branch: undefined });
  assert.equal(waitsOn(withOpen, [withOpen]).length, 1, "one pull request still open holds it");
});

test("A11-206: a blocker whose merged pull request is not read yet holds the run, and says so", () => {
  const unread = behind183({ blockersDeclared: undefined });
  assert.deepEqual(waitsOn(unread, [unread]).map((b) => b.key), ["A11-183"]);
  assert.equal(waitNote(unread, [unread]), "Waits for A11-183 (its merged pull requests are not read yet)");
  const oneRead = behind183({}, { ...A183, pulls: { [FLEET_PULL]: "merged", [CONTROL_PULL]: "merged" } });
  assert.equal(waitNote(oneRead, [oneRead]), "Waits for A11-183 (its merged pull requests are not read yet)", "every merged pull request has to be read");
  const done = behind183({ blockersDeclared: undefined }, { ...A183, state: "completed" });
  assert.deepEqual(waitsOn(done, [done]), [], "a Done blocker needs no read");
  const ended = run183({ phase: "finished", outcome: { kind: "ready-pr", prs: [{ url: FLEET_PULL }] }, pullStates: { [FLEET_PULL]: "merged" } });
  assert.deepEqual(waitsOn(unread, [unread, ended]), [], "and a blocker whose own run is Completed needs none either");
});

test("A11-206: Done releases a blocker that has a live run, and one whose merged pull request declared Partial:", () => {
  const done = behind183({ blockersDeclared: { [FLEET_PULL]: { kind: "partial", remains: "step 1 of 2" } } }, { ...A183, state: "completed" });
  assert.deepEqual(waitsOn(done, [done, run183({ phase: "running" })]), [], "Done with a live run on the queue");
  assert.deepEqual(waitsOn(done, [done]), [], "Done with a partial declaration");
  for (const state of ["canceled", "duplicate"]) {
    const gone = behind183({}, { ...A183, state });
    assert.deepEqual(waitsOn(gone, [gone, run183({ phase: "running" })]).map((b) => b.key), ["A11-183"], `a ${state} blocker never lets go, with a live run too`);
    assert.equal(waitNote(gone, [gone, run183({ phase: "running" })]), `A11-183 was ${state === "canceled" ? "canceled" : "marked a duplicate"}: a person decides`);
  }
});

test("A11-154: Respond is offered on every finished run with an open pull request, whatever its outcome, and on no other", () => {
  for (const outcome of [
    { kind: "needs-human", reason: "which colour?" }, { kind: "crashed", reason: "herdr found no agent" }, { kind: "no-outcome" }, { kind: "wrong-repo", where: "a11ign/control" },
    { kind: "ready-pr", prs: [OPEN_PR] }, { kind: "reviewed", prs: [OPEN_PR] },
  ] as const) {
    const entry = withOpenPull({ outcome: outcome as ViewEntry["outcome"] });
    assert.ok(runActions(entry).includes("respond"), `${outcome.kind} with a pull request open`);
    assert.equal(runActions(entry)[0], "respond", `${outcome.kind}: first among the actions`);
  }
  const crashed = withOpenPull({ outcome: { kind: "crashed", reason: "x" } });
  assert.deepEqual(runActions(crashed), ["respond", "retry", "talk", "dismiss"], "Retry stays beside it for a run that did not end well");
  const parked = withOpenPull({ workspace: "w1", pane: "w1:p1", outcome: { kind: "needs-human", reason: "which colour?" } });
  assert.deepEqual(runActions(parked), ["close", "respond", "dismiss"], "a parked run offers it too: Respond closes the workspace first");
  const draft = withOpenPull({ outcome: { kind: "draft-pr", prs: [OPEN_PR] } });
  assert.deepEqual(runActions(draft), ["approve", "talk", "dismiss"], "a draft keeps its Approve, which is how Respond acts on it");
  assert.ok(!runActions(run({ outcome: { kind: "needs-human", reason: "x" } })).includes("respond"), "no pull request, nothing to respond to");
  for (const outcome of [{ kind: "checked", reason: "nothing to do" }, { kind: "stopped" }] as const) {
    assert.ok(!runActions(withOpenPull({ outcome })).includes("respond"), `${outcome.kind}: nothing for a worker to answer`);
  }
  const merged = run({ pullStates: { [OPEN_PR.url]: "merged" }, review: [OPEN_PR], outcome: { kind: "needs-human", reason: "x" } });
  assert.ok(!runActions(merged).includes("respond"), "a merged pull request is not open");
  for (const trackerState of ["completed", "canceled"]) {
    const settled = withOpenPull({ trackerState, outcome: { kind: "needs-human", reason: "x" } });
    assert.ok(!runActions(settled).includes("respond"), `the tracker ${trackerState} the ticket`);
  }
});

test("A11-154: a run the board handed back reads Needs you whatever its outcome ended on, and one it did not stays as its outcome says", () => {
  const handed = "The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped. Respond to review starts another.";
  for (const outcome of [{ kind: "ready-pr", prs: [OPEN_PR] }, { kind: "reviewed", prs: [OPEN_PR] }, { kind: "needs-human", reason: "x" }, { kind: "crashed", reason: "x" }] as const) {
    assert.equal(runStatus(withOpenPull({ outcome: outcome as ViewEntry["outcome"], handedBack: handed })), "needs-you", `${outcome.kind}, handed back`);
    assert.ok(runActions(withOpenPull({ outcome: outcome as ViewEntry["outcome"], handedBack: handed })).includes("respond"), `${outcome.kind}: Respond starts another round`);
  }
  assert.equal(runStatus(withOpenPull({ outcome: { kind: "ready-pr", prs: [OPEN_PR] } })), "awaiting-review", "a ready run not handed back still awaits its review");
  assert.equal(runStatus(withOpenPull({ outcome: { kind: "reviewed", prs: [OPEN_PR] }, handedBack: undefined, pullHeads: { [OPEN_PR.url]: GREEN_HEAD } })), "ready-to-merge");
  assert.equal(runStatus(run({ pullStates: { [OPEN_PR.url]: "merged" }, outcome: { kind: "reviewed", prs: [OPEN_PR] }, handedBack: handed })), "completed", "a merge settles it, handed back or not");
  assert.equal(runStatus(withOpenPull({ trackerState: "completed", outcome: { kind: "reviewed", prs: [OPEN_PR] }, handedBack: handed })), "completed", "and so does the tracker");
});

test("A11-154: a queued round held back by a working Talk session is Blocked with its wait note, offers no Start anyway, and the line for rerun checks names them", () => {
  const waitingRound = run({ phase: "queued", review: [OPEN_PR], sessionWait: "Waits for the Talk session in w3 to end" });
  assert.equal(runStatus(waitingRound, [waitingRound]), "blocked");
  assert.equal(waitNote(waitingRound, [waitingRound]), "Waits for the Talk session in w3 to end");
  assert.deepEqual(runActions(waitingRound, undefined, [waitingRound]), ["remove"]);
  const free = run({ phase: "queued", review: [OPEN_PR] });
  assert.equal(runStatus(free, [free]), "queued", "POSITIVE CONTROL: the same round with no hold starts");
  const reran = withOpenPull({ checkHeads: { [OPEN_PR.url]: { head: "1a2b3c4d5e6f", step: "rerun", note: "Reran test on 1a2b3c4d: a runner was lost" } } });
  assert.equal(checkNote(reran), "Reran test on 1a2b3c4d: a runner was lost");
  assert.equal(checkNote({ ...reran, phase: "running" }), null, "a run in a round says nothing of the last one's");
  assert.equal(checkNote(withOpenPull({ checkHeads: { [OPEN_PR.url]: { head: "1a2b3c4d5e6f", step: "round" } } })), null, "a head answered by a round has no line");
  assert.equal(reasonOf({ ...reran, handedBack: "Reran test on 1a2b3c4d: a runner was lost" }).line, null, "the card says the line once");
});

test("A11-154: a parked run the board handed back keeps its question one click away, and a rerun note goes with the pull request", () => {
  const parked = withOpenPull({ outcome: { kind: "needs-human", reason: "which colour?" }, handedBack: "The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped." });
  assert.deepEqual(reasonOf(parked), { line: parked.handedBack, question: "which colour?" });
  assert.deepEqual(reasonOf(withOpenPull({ outcome: { kind: "needs-human", reason: "which colour?" } })), { line: "which colour?", question: null }, "a run not handed back says its question as the line");
  const note = { [OPEN_PR.url]: { head: "1a2b3c4d5e6f", step: "rerun" as const, note: "Reran test on 1a2b3c4d: a runner was lost" } };
  assert.equal(checkNote(withOpenPull({ checkHeads: note })), "Reran test on 1a2b3c4d: a runner was lost");
  assert.equal(checkNote(run({ checkHeads: note, pullStates: { [OPEN_PR.url]: "merged" }, review: [OPEN_PR] })), null, "a merged pull request has no checks to say anything of");
});

// A11-161: what the board says when the reviewer is off and when the publisher is. The words are the ticket's, exactly.
test("A11-161: the words the board says of a reviewer that is off, and of a machine where people review, are the ticket's exactly", () => {
  assert.equal(REVIEWER_OFF_BANNER, "Reviews are required and the reviewer is off");
  assert.equal(REVIEWER_OFF_LINE, "waiting on the reviewer (off)");
  assert.equal(AWAITING_PERSON_LINE, "awaiting your review");
});

test("A11-161: the banner is the reviewer's only when reviews are required and it is off: not for a reviewer that is on, not for none that is not required, and not for an instance that sends no state", () => {
  assert.equal(reviewerBanner("off-required"), "Reviews are required and the reviewer is off");
  for (const state of ["on", "none", undefined]) assert.equal(reviewerBanner(state), null, String(state));
});

test("A11-161: a run says \"publishing off\" only when it is Ready to merge on a machine whose publisher is installed and switched off", () => {
  assert.equal(publishingOffLine("ready-to-merge", "off"), "publishing off");
  for (const status of ["published", "working", "needs-you", "awaiting-review", "publishing"]) assert.equal(publishingOffLine(status, "off"), null, status);
  for (const publisher of ["on", "none", undefined]) assert.equal(publishingOffLine("ready-to-merge", publisher), null, String(publisher));
});

const STEP_PR = "https://github.com/a11ign/agent-org/pull/1811";
/** The merged bodies were read and declared nothing that overrules the outcome (A11-181): a run's `partial` is then acted on, and shown, as the worker wrote it. */
const READ: PullDeclared = { kind: "none", urls: [STEP_PR] };
const queuedStep = (fields: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "A11-160" }, phase: "queued", steps: [{ step: 1, of: 9, prs: [STEP_PR] }], ...fields });

test("A11-168: a next-step run's line says step 1 of 9 merged; step 2 queued, and running once it started", () => {
  assert.deepEqual(reasonOf(queuedStep()), { line: "step 1 of 9 merged; step 2 queued", question: null });
  assert.equal(reasonOf(queuedStep({ phase: "running" })).line, "step 1 of 9 merged; step 2 running");
  assert.equal(reasonOf(queuedStep({ steps: [{ step: 1, of: 9, prs: [STEP_PR] }, { step: 2, of: 9, prs: [] }] })).line, "step 2 of 9 merged; step 3 queued", "the last merged step is the one named");
  assert.equal(reasonOf(queuedStep({ steps: undefined })).line, null, "a run that is no later step says nothing");
});

test("A11-168: a worker's own note on a running next step is not hidden by the step line", () => {
  assert.equal(reasonOf(queuedStep({ phase: "running", working: { reason: "the tests are still running" } })).line, "the tests are still running");
});

test("A11-168: a merged partial run the board did not queue a step for reads Needs you with the reason as its line, and the tracker's word on the ticket wins", () => {
  const merged = (fields: Partial<ViewEntry>): ViewEntry => run({ outcome: { kind: "ready-pr", prs: [{ url: STEP_PR }] }, pullStates: { [STEP_PR]: "merged" }, declared: READ, ...fields });
  const stalled = merged({ partial: "step 9 of 9: the docs" });
  assert.equal(runStatus(stalled), "needs-you");
  assert.equal(reasonOf(stalled).line, "Partial merged: step 9 of 9: the docs. It names step 9 of 9, the last, with Partial: the last step closes the ticket");
  assert.equal(reasonOf(merged({ partial: "the docs" })).line, "Partial merged: the docs. It names no step, so nothing was queued: Dismiss it and queue the ticket");
  assert.equal(reasonOf(merged({ partial: "step 1 of 9", steps: [{ step: 1, of: 9, prs: [] }] })).line, "Partial merged: step 1 of 9. Step 1 is not after step 1: nothing was queued");
  const byPerson = merged({ partial: "the docs", trackerState: "completed", completedBy: "person" });
  assert.deepEqual([runStatus(byPerson), reasonOf(byPerson).line], ["completed", "completed: a11ign/agent-org #1811 merged"], "a ticket a person completed is completed, and the card says what completed it (A11-178)");
  assert.equal(runStatus(merged({})), "completed", "a pull request with no declaration completes the run as before");
  assert.equal(reasonOf(merged({})).line, "completed: a11ign/agent-org #1811 merged");
});

test("A11-178: a ticket the tracker completed while the run's work was partial reads Needs you, with the declaration and why the board could not put it back, until a person is found to have completed it", () => {
  const merged = (fields: Partial<ViewEntry>): ViewEntry => run({ outcome: { kind: "ready-pr", prs: [{ url: STEP_PR }] }, pullStates: { [STEP_PR]: "merged" }, declared: READ, partial: "step 1 of 9: the board", trackerState: "completed", ...fields });
  const early = merged({});
  assert.deepEqual([runStatus(early), reasonOf(early).line], ["needs-you", "Done in the tracker, but its last merged pull request declared Partial: step 1 of 9: the board; the board could not put it back (it has not been asked yet)"]);
  const refused = merged({ reopenFailure: "Linear answered 502: bad gateway" });
  assert.equal(reasonOf(refused).line, "Done in the tracker, but its last merged pull request declared Partial: step 1 of 9: the board; the board could not put it back (Linear answered 502: bad gateway)");
  assert.deepEqual([runStatus(merged({ completedBy: "person" })), runStatus(merged({ partial: undefined })), runStatus(merged({ trackerState: undefined }))], ["completed", "completed", "needs-you"],
    "a person's completion, a pull request with no declaration, and a ticket the tracker has not completed are each as they were");
  assert.ok(runActions(early).includes("dismiss"), "a person can still dismiss it");
});

test("A11-178: a later step whose own pull request is still open when the tracker completes the ticket reads Needs you, and a later step that has merged, or has no pull request of its own, reads Completed", () => {
  const laterStep = (fields: Partial<ViewEntry>): ViewEntry => run({ steps: [{ step: 1, of: 3, prs: [STEP_PR] }], outcome: { kind: "ready-pr", prs: [{ url: PLUGIN_PR }] }, pullStates: { [PLUGIN_PR]: "open" }, trackerState: "completed", ...fields });
  assert.deepEqual([runStatus(laterStep({})), reasonOf(laterStep({})).line], ["needs-you",
    "Done in the tracker, but step 2's pull request is not merged (a11ign/plugin #9); the board could not put it back (it has not been asked yet)"]);
  assert.equal(runStatus(laterStep({ pullStates: { [PLUGIN_PR]: "merged" } })), "completed", "the last step's own merge completing the ticket is the end of the plan");
  assert.equal(runStatus(laterStep({ completedBy: "person" })), "completed");
  assert.equal(runStatus(laterStep({ outcome: { kind: "done", reason: "nothing to build" } as never, pullStates: undefined })), "completed", "a step that ended with no pull request of its own has nothing the tracker completed early");
});

test("A11-168: a merged partial run is dismissed, not retried, and a closed unmerged one is still cancelled", () => {
  const stalled = run({ outcome: { kind: "ready-pr", prs: [{ url: STEP_PR }] }, pullStates: { [STEP_PR]: "merged" }, partial: "the docs" });
  assert.ok(runActions(stalled).includes("dismiss") && !runActions(stalled).includes("retry"));
  assert.equal(runStatus({ ...stalled, pullStates: { [STEP_PR]: "closed" } }), "cancelled");
});

const FROM_TEXT = "# Problem\n\nThe replay drops pages.\n\n## Done-when\n\n* it replays";
const TO_TEXT = "# Problem\n\nThe replay drops pages.\n\n## Done-when\n\n* it replays\n* it handles the cookie dialog";
const CHANGE = { at: Date.UTC(2026, 9, 21, 14, 5), from: FROM_TEXT, to: TO_TEXT };
/** The time of day the board words, in the viewer's zone, as the line says it. */
const clock = (ms: number): string => `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;

test("A11-167: a queued run whose plan is stale says the ticket changed since the plan and that it re-plans first, with the change its What changed link opens", () => {
  const stale = run({ phase: "queued", ticketChange: CHANGE });
  assert.equal(reasonOf(stale).line, "ticket changed since plan, re-planning first");
  assert.equal(STALE_PLAN_LINE, "ticket changed since plan, re-planning first");
  assert.deepEqual(ticketChangeOf(stale), { line: STALE_PLAN_LINE, change: CHANGE });
});

test("A11-167: the run that plans again says it is planning because the ticket changed", () => {
  const replanning = run({ phase: "running", plan: { model: "opus", effort: "max" }, ticketChange: CHANGE });
  assert.equal(reasonOf(replanning).line, "planning (ticket changed)");
  assert.equal(REPLANNING_LINE, "planning (ticket changed)");
});

test("A11-167: a live run its ticket's change was sent to says when, at the time of day the change was sent, with the same change to open", () => {
  const sent = run({ phase: "running", ticketChanges: [{ ...CHANGE, at: CHANGE.at - 60_000 }, CHANGE] });
  assert.equal(reasonOf(sent).line, `ticket changed: sent to the worker at ${clock(CHANGE.at)}`);
  assert.deepEqual(ticketChangeOf(sent)?.change, CHANGE, "the latest change");
  assert.equal(reasonOf(run({ phase: "starting", ticketChanges: [CHANGE] })).line, `ticket changed: sent to the worker at ${clock(CHANGE.at)}`);
});

test("A11-167: a finished run, and a run its ticket never changed under, say nothing of a change", () => {
  assert.equal(ticketChangeOf(run({ phase: "finished", ticketChange: CHANGE, ticketChanges: [CHANGE] })), null, "its next round's brief carries the new text");
  assert.equal(ticketChangeOf(run({ phase: "running" })), null);
  assert.equal(ticketChangeOf(run({ phase: "queued" })), null);
});

test("A11-167: a queued dependent shows one line for the pull requests its planner learns from, in the order it learned them, each named by its blocker and number", () => {
  const learned = { "https://github.com/a11ign/announcement-emulator/pull/3": { key: "A11-165", number: 3, file: "/t/blockers/a.md" }, "https://github.com/a11ign/x/pull/9": { key: "A11-164", number: 9, file: "/t/blockers/b.md" } };
  const waiting = run({ phase: "queued", learned });
  assert.equal(learnsLine(waiting), "learns from A11-165 (#3 merged), A11-164 (#9 merged)");
  assert.deepEqual(learnsFrom(waiting), [{ text: "A11-165 (#3 merged)", url: "https://github.com/a11ign/announcement-emulator/pull/3" }, { text: "A11-164 (#9 merged)", url: "https://github.com/a11ign/x/pull/9" }]);
  assert.equal(learnsLine(run({ phase: "queued" })), null);
  assert.equal(learnsLine(run({ phase: "running", learned })), null, "a run that has started has been briefed");
});

test("A11-167: What changed shows the old description struck and the new added, and the lines both share as they are", () => {
  assert.deepEqual(diffLines(FROM_TEXT, TO_TEXT), [
    ...FROM_TEXT.split("\n").map((text) => ({ kind: "same", text })),
    { kind: "added", text: "* it handles the cookie dialog" },
  ]);
  assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc"), [{ kind: "same", text: "a" }, { kind: "removed", text: "b" }, { kind: "added", text: "B" }, { kind: "same", text: "c" }]);
  assert.deepEqual(diffLines("a\r\nb  ", "a\nb"), [{ kind: "same", text: "a" }, { kind: "same", text: "b" }], "line ends and trailing space are not edits");
  assert.deepEqual(diffLines("gone", "new"), [{ kind: "removed", text: "gone" }, { kind: "added", text: "new" }]);
  assert.deepEqual(diffLines("", ""), [{ kind: "same", text: "" }]);
});

test("A11-171: a talk session is Talking while it runs and while it waits parked, whatever plan it carries, and it offers Talk while it holds its pane", () => {
  const plan = { model: "opus", effort: "max" };
  const talk = (phase: string, fields: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "NBF-1" }, phase, talk: true, plan, ...fields });
  assert.equal(runStatus(talk("running", { workspace: "w1", pane: "w1:p1" })), "talking", "not Planning");
  assert.equal(runStatus(talk("finished", { workspace: "w1", pane: "w1:p1", outcome: { kind: "needs-human" } })), "talking", "waiting for the person in the terminal, not Needs you");
  assert.equal(runStatus(talk("finished", { outcome: { kind: "needs-human" } })), "needs-you", "its pane closed: the session is over");
  assert.equal(runStatus(talk("queued")), "queued", "a queued one holds no pane yet");
  assert.equal(runStatus(talk("running", { workspace: "w1", pane: "w1:p1", waiting: true })), "needs-you", "an agent blocked on a person still needs them");
  assert.equal(runStatus(talk("finished", { workspace: "w1", pane: "w1:p1", trackerState: "completed", outcome: { kind: "needs-human" } })), "completed", "a settled run is not Talking, whatever pane it holds");
  assert.deepEqual(runActions(talk("running", { workspace: "w1", pane: "w1:p1" })), ["talk", "stop"]);
  assert.deepEqual(runActions(talk("finished", { workspace: "w1", pane: "w1:p1", outcome: { kind: "needs-human" } })), ["talk", "close", "dismiss"]);
  const parked: ViewEntry = { ticket: { key: "NBF-1" }, phase: "finished", workspace: "w1", pane: "w1:p1", outcome: { kind: "needs-human" } };
  assert.deepEqual(runActions(parked), ["close", "dismiss"], "a parked run that is no talk session gains no Talk");
});

test("A11-171: a batch's tickets that wait for a person on its one pane say so, naming the others that share it, and nothing else says it", () => {
  const parked = (key: string, fields: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key }, phase: "finished", batch: "b0-0", workspace: "w1", pane: "w1:p1", outcome: { kind: "needs-human" }, ...fields });
  const entries = [parked("NBF-2"), parked("NBF-3"), parked("NBF-4"), { ticket: { key: "NBF-1" }, phase: "queued" }, parked("NBF-5", { batch: "b9-9", workspace: "w9" })];
  assert.equal(sharedRunNote(entries[0], entries), "Planned together with NBF-3, NBF-4: answer in the batch's terminal");
  assert.equal(sharedRunNote(entries[2], entries), "Planned together with NBF-2, NBF-3: answer in the batch's terminal");
  assert.equal(sharedRunNote(entries[3], entries), null, "a ticket that left the batch with its plan");
  assert.equal(sharedRunNote(entries[4], entries), null, "alone on its pane");
  assert.equal(sharedRunNote(parked("NBF-2", { workspace: undefined, pane: undefined }), entries), null, "its pane is closed: nothing to answer in");
  assert.equal(sharedRunNote({ ...entries[0], phase: "running" }, entries), null, "still planning: nobody is asked anything");
  const talking = (key: string): ViewEntry => ({ ticket: { key }, phase: "running", talk: true, batch: "b0-0", workspace: "w5", pane: "w5:p1" });
  assert.equal(sharedRunNote(talking("NBF-2"), [talking("NBF-2"), talking("NBF-3")]), "Planned together with NBF-3: answer in the batch's terminal", "a batch's talk session too");
});

test("A11-171: every card of a batch, and every press of Talk, names the same terminal tab", () => {
  const card = (key: string, batch?: string): ViewEntry => ({ ticket: { key }, phase: "running", ...(batch ? { batch } : {}) });
  assert.equal(terminalTab(card("NBF-2", "b0-0")), terminalTab(card("NBF-3", "b0-0")));
  assert.notEqual(terminalTab(card("NBF-2")), terminalTab(card("NBF-3")));
  assert.equal(terminalTab(card("NBF-2")), "terminal-NBF-2");
});

const PLUGIN_PR = "https://github.com/a11ign/plugin/pull/9";
const AGENT_ORG_PR = "https://github.com/a11ign/agent-org/pull/1815";

test("A11-173: a Completed run's line says completed: a11ign/agent-org #1815, a11ign/plugin #9 merged", () => {
  const both = run({ outcome: { kind: "ready-pr", prs: [{ url: AGENT_ORG_PR }, { url: PLUGIN_PR }] }, pullStates: { [AGENT_ORG_PR]: "merged", [PLUGIN_PR]: "merged" } });
  assert.equal(runStatus(both), "completed");
  assert.deepEqual(reasonOf(both), { line: "completed: a11ign/agent-org #1815, a11ign/plugin #9 merged", question: null });
  const reviewed = run({ outcome: { kind: "reviewed", prs: [{ url: AGENT_ORG_PR }] }, pullStates: { [AGENT_ORG_PR]: "merged" } });
  assert.equal(reasonOf(reviewed).line, "completed: a11ign/agent-org #1815 merged", "a reviewed run too");
  const closedOne = run({ outcome: { kind: "ready-pr", prs: [{ url: AGENT_ORG_PR }, { url: PLUGIN_PR }] }, pullStates: { [AGENT_ORG_PR]: "merged", [PLUGIN_PR]: "closed" } });
  assert.equal(reasonOf(closedOne).line, "completed: a11ign/agent-org #1815 merged", "only the pull requests that merged are named");
  const doneAfterReview = run({ outcome: { kind: "done", reason: "PR #1815 is merged", evidence: ["e"] } as never, review: [{ url: AGENT_ORG_PR }], pullStates: { [AGENT_ORG_PR]: "merged" } });
  assert.deepEqual(reasonOf(doneAfterReview), { line: "completed: a11ign/agent-org #1815 merged", question: "PR #1815 is merged" }, "a done's reason stays one click away");
  const doneAlone = run({ outcome: { kind: "done", reason: "nothing to build", evidence: ["e"] } as never });
  assert.deepEqual(reasonOf(doneAlone), { line: "nothing to build", question: null }, "a done with no merged pull request keeps its reason as the line");
  const partial = { ...both, partial: "step 1 of 3", declared: READ };
  assert.deepEqual([runStatus(partial), reasonOf(partial).line], ["needs-you", null], "a partial run is not Completed, and does not say it was");
});

test("A11-173: a run with After-merge lines reads Completed, not Needs you, and says how many it listed", () => {
  const listed = run({ ticket: { key: "A11-145", url: "https://linear.app/a11ign/issue/A11-145" }, outcome: { kind: "ready-pr", prs: [{ url: STEP_PR }] }, pullStates: { [STEP_PR]: "merged" },
    afterMerge: [{ line: "the laptop run shows 3 of 3. The chairman, after merge.", owner: "The chairman" }, { line: "a second check", owner: null }] });
  assert.equal(runStatus(listed), "completed");
  assert.equal(reasonOf(listed).line, "completed: a11ign/agent-org #1811 merged; 2 after-merge checks listed");
  assert.equal(reasonOf({ ...listed, afterMerge: [listed.afterMerge![0]] }).line, "completed: a11ign/agent-org #1811 merged; 1 after-merge check listed");
});

test("A11-277: the After-merge checks list is the open checks and the failed ones with no follow-up, oldest first, each with its owner, runner and role", () => {
  const url = "https://linear.app/a11ign/issue/A11-145";
  const runs = [
    { ticket: { key: "A11-145", url }, finishedAt: 2_000, afterMerge: [{ line: "the laptop run shows 3 of 3. The chairman, after merge.", owner: "The chairman" }, { line: "a second check", owner: null }] },
    { ticket: { key: "A11-150" }, finishedAt: 1_000, afterMerge: [{ line: "The release manager: a live check", owner: null }] },
    { ticket: { key: "A11-146" } },
  ];
  const seeded = seedChecks(emptyChecks(), runs, 9_000);
  assert.deepEqual(afterMergeChecks(seeded), [
    { id: "A11-150#1", key: "A11-150", url: null, line: "The release manager: a live check", runner: "session", listedAt: 1_000, state: "open", owner: "The release manager", role: "The release manager", followUpText: null, needsYou: null, overdue: false },
    { id: "A11-145#1", key: "A11-145", url, line: "the laptop run shows 3 of 3. The chairman, after merge.", runner: "session", listedAt: 2_000, state: "open", owner: "The chairman", role: null, followUpText: null, needsYou: null, overdue: false },
    { id: "A11-145#2", key: "A11-145", url, line: "a second check", runner: "session", listedAt: 2_000, state: "open", owner: "owner not named", role: null, followUpText: null, needsYou: null, overdue: false },
  ], "oldest first, with 'owner not named' where the line names none; a run with none adds none");
  const close = (file: ChecksFile, id: string, result: "passed" | "failed") => {
    const closed = closeCheck(file, id, { result, evidence: "seen on the board", by: "person" }, 10_000);
    assert.ok(closed.ok);
    return closed.file;
  };
  const failed = close(close(seeded, "A11-150#1", "passed"), "A11-145#2", "failed");
  assert.deepEqual(afterMergeChecks(failed).map(({ id, state }) => [id, state]), [["A11-145#1", "open"], ["A11-145#2", "failed"]], "a passed check leaves; a failed one stays until its follow-up is decided");
  assert.match(afterMergeChecks(failed)[1].followUpText ?? "", /^Follow-up to A11-145: its after-merge check failed\./);
  const decided = decideFollowUp(failed, "A11-145#2", null);
  assert.ok(decided.ok);
  assert.deepEqual(afterMergeChecks(decided.file).map(({ id }) => id), ["A11-145#1"], "a decided follow-up takes the failed check off the list");
  assert.deepEqual(afterMergeChecks(emptyChecks()), []);
});

// A11-175: a run on one step of a multi-step plan holds that step's paths and its open pull requests' files, not the whole plan's. A11-160 (step 3 of 9) held every path its nine steps name, so A11-173 and
// A11-174 sat Blocked on pool-settle.ts and safety-prompt.ts, which its open pull request does not touch.
const STEP_PULL = "https://github.com/a11ign/agent-org/pull/1824";
const PLAN_PATHS = ["agent-org:src/", "agent-org:plugins/", "agent-org:docs/gh-call-baseline.json"];
const STEP_3_FILES = ["plugins/github/reviews.ts", "src/ticket-mode/reviewer-port.ts"];
/** A11-160 as it stood: finished on step 3 with its pull request open, its plan's paths the whole nine steps'. */
const stepThree = (patch: Partial<ViewEntry> = {}) => holderOf("A11-160", { phase: "finished", paths: PLAN_PATHS, partial: "step 3 of 9: reviews, checks and the verdict door", outcome: { kind: "ready-pr", prs: [pulled(STEP_PULL)] },
  pullFiles: { [STEP_PULL]: STEP_3_FILES }, ...patch });

test("A11-175: a finished step-3 run holds its step's paths and its pull request's files, not the plan's", () => {
  const run = stepThree({ stepPaths: { "2": ["agent-org:plugins/identity/"], "3": ["agent-org:plugins/github/", "agent-org:src/ticket-mode/reviewer-port.ts"], "4": ["agent-org:src/ticket-port/"] } });
  assert.deepEqual(footprintOf(run), ["agent-org:plugins/github/", "agent-org:src/ticket-mode/reviewer-port.ts", "agent-org:plugins/github/reviews.ts", "agent-org:src/ticket-mode/reviewer-port.ts"]);
  for (const file of ["src/ticket-mode/pool-settle.ts", "src/ticket-mode/safety-prompt.ts", "plugins/identity/gh.ts", "src/ticket-port/port.ts"]) {
    const waiting = waitingOn([`agent-org:${file}`], { ticket: { key: "A11-173" } });
    assert.equal(overlapWait(waiting, [run, waiting]), null, `${file} is another step's, or no step's: not held`);
    assert.equal(runStatus(waiting, [run, waiting]), "queued");
  }
  const sharing = waitingOn(["agent-org:plugins/github/pull-feedback.ts"], { ticket: { key: "A11-173" } });
  assert.deepEqual(overlapWait(sharing, [run, sharing]), { key: "A11-160", pull: "1824", path: "plugins/github/pull-feedback.ts", overlaps: [{ path: "plugins/github/pull-feedback.ts", folderOf: "A11-160", folder: "plugins/github/" }] }, "a file in its step's directory still holds");
  const touched = waitingOn(["agent-org:src/ticket-mode/reviewer-port.ts"], { ticket: { key: "A11-173" } });
  assert.equal(overlapWait(touched, [run, touched])?.key, "A11-160", "and so does a file its pull request changes");
});

test("A11-175: a step with no paths of its own holds only its open pull request's files, as A11-160's does, whose plan numbers its steps as table rows", () => {
  const run = stepThree();
  assert.deepEqual(footprintOf(run), ["agent-org:plugins/github/reviews.ts", "agent-org:src/ticket-mode/reviewer-port.ts"], "no new read of its plan: its partial names the step, and its pull request is open");
  for (const file of ["src/ticket-mode/pool-settle.ts", "src/ticket-mode/safety-prompt.ts"]) {
    const waiting = waitingOn([`agent-org:${file}`], { ticket: { key: file.includes("settle") ? "A11-173" : "A11-174" } });
    assert.equal(overlapWait(waiting, [run, waiting]), null, `${file}: the pull request does not touch it, so the chairman need not press Start`);
    assert.equal(waitNote(waiting, [run, waiting]), null);
  }
  const touching = waitingOn(["agent-org:src/ticket-mode/reviewer-port.ts"]);
  assert.deepEqual(overlapWait(touching, [run, touching]), { key: "A11-160", pull: "1824", path: "src/ticket-mode/reviewer-port.ts", overlaps: [{ path: "src/ticket-mode/reviewer-port.ts", folderOf: null, folder: null }] });
  const unread = stepThree({ pullFiles: undefined });
  assert.deepEqual(footprintOf(unread), [], "a pull request whose files are not read holds none by name");
  const waiting = waitingOn(["agent-org:src/ticket-mode/pool-settle.ts"]);
  assert.deepEqual(overlapWait(waiting, [unread, waiting]), { key: "A11-160", pull: "1824", path: null, overlaps: [] }, "but its repository is held until a watch reads them (A11-125)");
  const review = stepThree({ phase: "queued", review: [pulled(STEP_PULL)] });
  assert.deepEqual(footprintOf(review), footprintOf(run), "a review round of the step holds the same");
  const merged = stepThree({ pullStates: { [STEP_PULL]: "merged" } });
  assert.deepEqual(footprintOf(merged), PLAN_PATHS, "a step whose pull request is merged has none open: its footprint is the plan's, and it holds nothing since it is not holding (finished, no pull request open)");
  const mergedWaiting = waitingOn(["agent-org:src/ticket-mode/reviewer-port.ts"]);
  assert.equal(overlapWait(mergedWaiting, [merged, mergedWaiting]), null);
});

test("A11-175: a review round on a step's open pull request holds that pull request's files, queued or running, and not the whole plan: the incident's A11-173 and A11-174 stay free while the round answers the reviewer", () => {
  const round = stepThree({ phase: "queued", review: [pulled(STEP_PULL)] });
  const running = stepThree({ phase: "running", review: [pulled(STEP_PULL)] });
  const files = ["agent-org:plugins/github/reviews.ts", "agent-org:src/ticket-mode/reviewer-port.ts"];
  assert.deepEqual([footprintOf(round), footprintOf(running)], [files, files]);
  const waiting = waitingOn(["agent-org:src/ticket-mode/pool-settle.ts"], { ticket: { key: "A11-173" } });
  assert.equal(overlapWait(waiting, [running, waiting]), null);
});

test("A11-175: a running step with no paths and no pull request holds the whole plan, and so does a worker that is still going with a pull request open", () => {
  const running = holderOf("A11-160", { phase: "running", paths: PLAN_PATHS, steps: [{ step: 1, of: 9, prs: [] }, { step: 2, of: 9, prs: [] }] });
  assert.deepEqual(footprintOf(running), PLAN_PATHS, "step 3 is running and its files are unknown (A11-125)");
  const waiting = waitingOn(["agent-org:src/ticket-mode/pool-settle.ts"]);
  assert.equal(overlapWait(waiting, [running, waiting])?.key, "A11-160");
  const going = { ...running, outcome: { kind: "ready-pr", prs: [pulled(STEP_PULL)] } as ViewEntry["outcome"], pullFiles: { [STEP_PULL]: STEP_3_FILES } };
  assert.deepEqual(footprintOf(going), [...PLAN_PATHS, "agent-org:plugins/github/reviews.ts", "agent-org:src/ticket-mode/reviewer-port.ts"], "its worker may push more files than the pull request has now");
  const single = holderOf("APP-1", { phase: "finished", paths: PLAN_PATHS, outcome: { kind: "ready-pr", prs: [pulled(STEP_PULL)] }, pullFiles: { [STEP_PULL]: STEP_3_FILES } });
  assert.deepEqual(footprintOf(single), [...PLAN_PATHS, "agent-org:plugins/github/reviews.ts", "agent-org:src/ticket-mode/reviewer-port.ts"], "a run that is no step of a plan holds what it always held");
});

test("A11-175: a running step holds its step's paths, from the steps merged before it, and step 1 is the step of a plan whose sections list paths", () => {
  const stepPaths = { "1": ["agent-org:src/a/"], "2": ["agent-org:src/b/"], "3": ["agent-org:src/c/"] };
  assert.deepEqual(footprintOf(holderOf("APP-1", { phase: "running", paths: PLAN_PATHS, stepPaths, steps: [{ step: 1, of: 3, prs: [] }, { step: 2, of: 3, prs: [] }] })), ["agent-org:src/c/"]);
  assert.deepEqual(footprintOf(holderOf("APP-1", { phase: "running", paths: PLAN_PATHS, stepPaths })), ["agent-org:src/a/"], "no step merged and none declared: the first");
  assert.deepEqual(footprintOf(holderOf("APP-1", { phase: "running", paths: PLAN_PATHS, stepPaths, steps: [{ step: 3, of: 3, prs: [] }] })), PLAN_PATHS, "past the last section there is no step to hold: the plan's, as before");
});

test("A11-175: a queued later step contests only its step's paths, so it waits on nobody else in the plan's directories", () => {
  const stepPaths = { "3": ["agent-org:plugins/github/"], "4": ["agent-org:src/ticket-port/"] };
  const later = (patch: Partial<ViewEntry> = {}) => waitingOn(PLAN_PATHS, { ticket: { key: "A11-160" }, stepPaths, steps: [{ step: 1, of: 9, prs: [] }, { step: 2, of: 9, prs: [] }], ...patch });
  const other = holderOf("A11-190", { phase: "running", paths: ["agent-org:src/ticket-mode/pool.ts"] });
  assert.equal(overlapWait(later(), [other, later()]), null, "the whole plan's src/ would hold this run behind A11-190; its step 3 does not");
  const alike = holderOf("A11-191", { phase: "running", paths: ["agent-org:plugins/github/reviews.ts"] });
  assert.deepEqual(overlapWait(later(), [alike, later()]), { key: "A11-191", pull: null, path: "plugins/github/", overlaps: [{ path: "plugins/github/reviews.ts", folderOf: "A11-160", folder: "plugins/github/" }] }, "and a holder of its step's path still holds it");
  assert.equal(overlapWait(later({ steps: [{ step: 1, of: 9, prs: [] }, { step: 2, of: 9, prs: [] }, { step: 3, of: 9, prs: [] }] }), [alike]), null, "step 4 contests step 4's paths, not step 3's");
  const noPaths = later({ stepPaths: undefined });
  assert.equal(overlapWait(noPaths, [other, noPaths])?.key, "A11-190", "a step whose plan lists no paths for it contests the whole plan: its files are unknown");
});
