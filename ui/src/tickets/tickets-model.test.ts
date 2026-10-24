import { ANYONE, UNASSIGNED, YOU } from "../../../src/ticket-mode/assignee-filter.ts";
import { labelChoice } from "../../../src/ticket-mode/label-filters.ts";
import { config, OTHER, queueingConfig, queueOf, ticket } from "../../test/fixtures.ts";
import { ALL_GOALS_ID } from "../shell/shell-model.ts";
import {
  ALL_ITEM, countText, emptyPanelOf, everythingOpen, groupOfMenu, labelMenus, NO_TICKETS_TEXT, NOTHING_ASSIGNED_TEXT, pickableIn, planMenu, priorityMenu, queueOptionsOf, scopeWords,
  sectionsOf, segmentsOf, shownTickets, type BatchChoice, type BatchOverride, type Filters, type SegmentSource,
} from "./tickets-model.ts";

const NO_FILTERS: Filters = { search: "", priorities: new Set(), plan: null, labels: new Set(), goal: ALL_GOALS_ID };
const filtered = (changes: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...changes });
const keys = (tickets: readonly { key: string }[]): string[] => tickets.map((t) => t.key);

describe("shownTickets", () => {
  const tickets = [
    ticket({ key: "A11-1", title: "Fix the fleet", priority: 1, goals: ["Fleet"], uploads: ["plan.md"] } as never),
    ticket({ key: "A11-2", title: "Clean a boundary", priority: 3, goals: ["Clean boundaries"] }),
    ticket({ key: "A11-3", title: "Something else", project: "agent-org", labels: [{ name: "bug", group: "Type" }] }),
  ];

  it("keeps every ticket with no filter", () => {
    expect(keys(shownTickets(tickets, tickets, NO_FILTERS, null))).toEqual(["A11-1", "A11-2", "A11-3"]);
  });

  it("keeps the tickets whose key, title or project has every word of the search", () => {
    expect(keys(shownTickets(tickets, tickets, filtered({ search: "fleet" }), null))).toEqual(["A11-1"]);
    expect(keys(shownTickets(tickets, tickets, filtered({ search: "agent-org" }), null))).toEqual(["A11-3"]);
  });

  it("keeps the tickets of the priorities chosen", () => {
    expect(keys(shownTickets(tickets, tickets, filtered({ priorities: new Set([3]) }), null))).toEqual(["A11-2"]);
  });

  it("keeps the tickets with a plan, or without one, when the machine names a plan pattern", () => {
    const plan = /plan/;
    expect(keys(shownTickets(tickets, tickets, filtered({ plan: "with" }), plan))).toEqual(["A11-1"]);
    expect(keys(shownTickets(tickets, tickets, filtered({ plan: "without" }), plan))).toEqual(["A11-2", "A11-3"]);
  });

  it("ignores a plan choice on a machine that names no plan pattern", () => {
    expect(shownTickets(tickets, tickets, filtered({ plan: "with" }), null)).toHaveLength(3);
  });

  it("keeps the tickets with a label chosen", () => {
    expect(keys(shownTickets(tickets, tickets, filtered({ labels: new Set([labelChoice("Type", "bug")]) }), null))).toEqual(["A11-3"]);
  });

  it("leaves a remembered choice of the Goal group to the sidebar, whose Goals choose it", () => {
    expect(shownTickets(tickets, tickets, filtered({ labels: new Set([labelChoice("Goal", "Fleet")]) }), null)).toHaveLength(3);
  });

  it("keeps the tickets of the goal the sidebar shows", () => {
    const fleet = `goal:Fleet`;
    expect(keys(shownTickets(tickets, tickets, filtered({ goal: fleet }), null))).toEqual(["A11-1"]);
  });
});

describe("sectionsOf", () => {
  const backlog = [ticket({ key: "A11-1" }), ticket({ key: "A11-2" }), ticket({ key: "A11-3" })];
  const started = [ticket({ key: "A11-4", status: "In Progress", statusOrder: 2 })];
  const all = [...started, ...backlog];

  it("is one section per status, in the workflow's order, each with how many the project holds", () => {
    const sections = sectionsOf(all, all, []);
    expect(sections.map(({ status, shown, total }) => [status, shown, total])).toEqual([["Backlog", 3, 3], ["In Progress", 1, 1]]);
  });

  it("keeps a status the filters leave nothing in, as a section with none shown", () => {
    const sections = sectionsOf(all, [backlog[0]], []);
    expect(sections.map(({ status, shown, total }) => [status, shown, total])).toEqual([["Backlog", 1, 3], ["In Progress", 0, 1]]);
    expect(sections[1].nodes).toEqual([]);
  });

  it("keeps every section when the filters leave no ticket", () => {
    expect(sectionsOf(all, [], []).map(({ status, shown }) => [status, shown])).toEqual([["Backlog", 0], ["In Progress", 0]]);
  });

  it("nests a ticket under its parent, in the parent's section, and counts only the tickets a worker can be given", () => {
    const parent = ticket({ key: "A11-10", children: ["A11-11"] } as never);
    const child = ticket({ key: "A11-11", parent: "A11-10", status: "In Progress", statusOrder: 2 });
    const [section] = sectionsOf([parent, child], [parent, child], []);
    expect(section.status).toBe("Backlog");
    expect(section.nodes[0].children.map((node) => node.ticket.key)).toEqual(["A11-11"]);
    expect([section.shown, section.total]).toEqual([1, 1]);
  });

  it("heads a child with a parent outside the scope as context, in the parent's section", () => {
    const outside = ticket({ key: "A11-10", assignee: OTHER, status: "In Progress", statusOrder: 2 });
    const child = ticket({ key: "A11-11", parent: "A11-10" });
    const [section] = sectionsOf([child], [child], [outside]);
    expect(section.status).toBe("In Progress");
    expect(section.nodes[0].context).toBe(true);
  });

  it("counts a status only the filtered tickets have as shown and as held, so it never reads 'of 0'", () => {
    const parent = ticket({ key: "A11-10", children: ["A11-11"] } as never);
    const child = ticket({ key: "A11-11", parent: "A11-10", status: "In Progress", statusOrder: 2 });
    const sections = sectionsOf([parent, child], [child], []);
    expect(sections.map(({ status, shown, total }) => [status, shown, total])).toEqual([["Backlog", 0, 1], ["In Progress", 1, 1]]);
  });
});

describe("pickableIn", () => {
  it("leaves out a ticket on the queue, a parent, a held decision and a ticket another instance holds", () => {
    const tickets = [
      ticket({ key: "A11-1" }), ticket({ key: "A11-2" }), ticket({ key: "A11-3", needsDecision: { kind: "open", reason: "x" } } as never), ticket({ key: "A11-4", taken: "other" } as never),
      ticket({ key: "A11-5", children: ["A11-6"] } as never),
    ];
    const [section] = sectionsOf(tickets, tickets, []);
    expect(keys(pickableIn(section, queueOf("queued")))).toEqual(["A11-2"]);
  });
});

describe("everythingOpen", () => {
  const parent = ticket({ key: "A11-10", children: ["A11-11"] } as never);
  const sections = sectionsOf([parent, ticket({ key: "A11-11", parent: "A11-10" }), ticket({ key: "A11-12", status: "Todo", statusOrder: 2 })], [parent, ticket({ key: "A11-11", parent: "A11-10" }), ticket({ key: "A11-12", status: "Todo", statusOrder: 2 })], []);

  it("is true when every section and every parent is open", () => {
    expect(everythingOpen(sections, new Set(["Backlog", "Todo"]), new Set(["A11-10"]))).toBe(true);
  });

  it("is false while a section or a parent is closed", () => {
    expect(everythingOpen(sections, new Set(["Backlog"]), new Set(["A11-10"]))).toBe(false);
    expect(everythingOpen(sections, new Set(["Backlog", "Todo"]), new Set())).toBe(false);
  });

  it("is false with no section", () => {
    expect(everythingOpen([], new Set(), new Set())).toBe(false);
  });
});

describe("the Assignee segments and the count", () => {
  const mine = [ticket({ key: "A11-1" }), ticket({ key: "A11-2" })];
  const theirs = [ticket({ key: "A11-3", assignee: OTHER }), ticket({ key: "A11-4", assignee: null })];
  const all = [...mine, ...theirs];
  const source = (changes: Partial<SegmentSource> = {}): SegmentSource => ({ ofProject: all, all, scope: YOU, config: config(), held: null, scopesRead: new Set(), ...changes });

  it("lists Mine, Anyone, Unassigned and each other person, with the count on the pressed one only", () => {
    expect(segmentsOf(source()).map(({ text, pressed, count }) => [text, pressed, count])).toEqual([["Mine", true, 2], ["Anyone", false, undefined], ["Unassigned", false, undefined], ["Someone", false, undefined]]);
  });

  it("counts Anyone and Unassigned when they are the ones pressed", () => {
    expect(segmentsOf(source({ scope: ANYONE })).find(({ pressed }) => pressed)?.count).toBe(4);
    expect(segmentsOf(source({ scope: UNASSIGNED })).find(({ pressed }) => pressed)?.count).toBe(1);
    expect(segmentsOf(source({ scope: OTHER.id })).find(({ pressed }) => pressed)).toMatchObject({ text: "Someone", count: 1 });
  });

  it("has no Mine when the tracker could not say whose key it is, and lists everyone with a ticket by name", () => {
    expect(segmentsOf(source({ config: config({ viewer: null }), scope: ANYONE })).map(({ text }) => text)).toEqual(["Anyone", "Unassigned", "Me", "Someone"]);
  });

  it("shows no count for a scope an on-demand instance has not read yet", () => {
    expect(segmentsOf(source({ config: config({ scopes: true } as never), scope: ANYONE })).find(({ pressed }) => pressed)?.count).toBeUndefined();
    expect(segmentsOf(source({ config: config({ scopes: true } as never), scope: ANYONE, scopesRead: new Set([ANYONE]) })).find(({ pressed }) => pressed)?.count).toBe(4);
  });

  it("words the count by the scope: assigned to you, unassigned, assigned to a person, or open", () => {
    expect(countText(2, source())).toBe("2 assigned to you");
    expect(countText(1, source({ scope: UNASSIGNED }))).toBe("1 unassigned");
    expect(countText(1, source({ scope: OTHER.id }))).toBe("1 assigned to Someone");
    expect(countText(4, source({ scope: ANYONE, config: config({ pickOpen: "open in team A11" } as never) }))).toBe("4 open in team A11");
  });

  it("words the count as the instance did before it named assignees", () => {
    const older = { pickDefault: "you", pick: "in team A11" } as never;
    expect(scopeWords(source({ config: older }))).toBe("in team A11");
  });
});

describe("emptyPanelOf", () => {
  const base: SegmentSource = { ofProject: [], all: [ticket({ key: "A11-3", assignee: OTHER })], scope: YOU, config: config(), held: null, scopesRead: new Set() };

  it("is the board's panel for the signed-in person's own tickets, with its buttons", () => {
    expect(emptyPanelOf(base, null)).toEqual({ title: "Nothing is assigned to you", text: NOTHING_ASSIGNED_TEXT, offersActions: true });
  });

  it("says why another scope holds none, with no buttons", () => {
    const panel = emptyPanelOf({ ...base, scope: UNASSIGNED }, null);
    expect(panel).toMatchObject({ title: "Nothing is unassigned", offersActions: false });
    expect(panel.text).toContain("No open ticket is unassigned");
  });

  it("gives the instance's own sentence when it lists no ticket at all, and waits for it", () => {
    expect(emptyPanelOf({ ...base, all: [] }, "No open tickets are assigned to Me, whose Linear key this board reads with.")).toMatchObject({ text: "No open tickets are assigned to Me, whose Linear key this board reads with.", offersActions: false });
    expect(emptyPanelOf({ ...base, all: [] }, null).text).toBeNull();
  });

  it("falls back to a plain line for a scope with nothing to say", () => {
    expect(emptyPanelOf({ ...base, scope: ANYONE }, null).text).toBe(NO_TICKETS_TEXT);
  });
});

describe("the filter menus", () => {
  const tickets = [
    ticket({ key: "A11-1", priority: 1, uploads: ["plan.md"], goals: ["Fleet"], labels: [{ name: "bug", group: "Type" }] } as never),
    ticket({ key: "A11-2", priority: 1, labels: [{ name: "bug", group: "Type" }, { name: "wip", group: null }] }),
    ticket({ key: "A11-3", priority: 3 }),
  ];

  it("lists All priorities and each priority the tickets have, most urgent first, with how many", () => {
    const menu = priorityMenu(tickets, new Set());
    expect(menu.items.map(({ text, count, chosen }) => [text, count, chosen])).toEqual([["All priorities", undefined, true], ["Urgent", 2, false], ["Medium", 1, false]]);
    expect(menu.name).toBe("Priority");
  });

  it("names the button after what is chosen, and keeps a chosen priority no ticket has at 0", () => {
    const menu = priorityMenu(tickets, new Set([1, 4]));
    expect(menu.name).toBe("Priority: Urgent, Low");
    expect(menu.items.find(({ text }) => text === "Low")).toMatchObject({ count: 0, chosen: true });
    expect(menu.items[0].chosen).toBe(false);
  });

  it("has a Plan menu only where the machine names a plan pattern", () => {
    expect(planMenu(tickets, null, null)).toBeNull();
    const menu = planMenu(tickets, /plan/, "with");
    expect(menu?.name).toBe("Plan: With a plan");
    expect(menu?.multiple).toBe(false);
    expect(menu?.items.map(({ text, count, chosen }) => [text, count, chosen])).toEqual([["All", undefined, false], ["With a plan", 1, true], ["Without a plan", 2, false]]);
  });

  it("has a menu for each label group but Goal, and one for the labels in no group", () => {
    const menus = labelMenus(tickets, tickets, new Set());
    expect(menus.map(({ label }) => label)).toEqual(["Type", "Labels"]);
    expect(menus[0].items.map(({ text, count }) => [text, count])).toEqual([["All", undefined], ["bug", 2], ["(no Type)", 1]]);
  });

  it("names a label button after the group and what is chosen, and clears a row with its All item", () => {
    const [menu] = labelMenus(tickets, tickets, new Set([labelChoice("Type", "bug")]));
    expect(menu.name).toBe("Type: bug");
    expect(menu.items[0]).toMatchObject({ id: ALL_ITEM, chosen: false });
    expect(groupOfMenu(menu.id)).toBe("Type");
    expect(groupOfMenu(labelMenus(tickets, tickets, new Set())[1].id)).toBeNull();
    expect(groupOfMenu("priority")).toBeUndefined();
  });
});

const choice = (override: BatchOverride, planFirst: boolean): BatchChoice => ({ override, planFirst });

describe("queueOptionsOf", () => {
  const unplanned = [ticket({ key: "A11-1" })];
  const planned = [ticket({ key: "A11-2", uploads: ["plan.md"] } as never)];

  it("offers Plan first while a selected ticket has no plan and the machine plans, and sends it ticked", () => {
    const options = queueOptionsOf(queueingConfig(), unplanned, choice({}, true));
    expect(options).toEqual({ planOffered: true, batch: { model: "sonnet", effort: "high", plan: true }, custom: false, customLabel: "Plan first · sonnet/high" });
  });

  it("does not offer it when every selected ticket has a plan, and never sends plan then", () => {
    expect(queueOptionsOf(queueingConfig(), planned, choice({}, true))).toMatchObject({ planOffered: false, batch: { plan: false }, custom: false, customLabel: "sonnet/high" });
  });

  it("does not offer it on a machine that does not plan", () => {
    expect(queueOptionsOf(queueingConfig({ planner: false }), unplanned, choice({}, true)).planOffered).toBe(false);
  });

  it("is Custom once the model or effort differs from the default, or Plan first is offered and unticked", () => {
    expect(queueOptionsOf(queueingConfig(), unplanned, choice({ model: "opus" }, true))).toMatchObject({ custom: true, customLabel: "Plan first · opus/high", batch: { model: "opus", effort: "high" } });
    expect(queueOptionsOf(queueingConfig(), unplanned, choice({ effort: "low" }, true))).toMatchObject({ custom: true, customLabel: "Plan first · sonnet/low" });
    expect(queueOptionsOf(queueingConfig(), unplanned, choice({}, false))).toMatchObject({ custom: true, customLabel: "No plan · sonnet/high", batch: { plan: false } });
  });

  it("is not Custom for an unticked Plan first that is not offered", () => {
    expect(queueOptionsOf(queueingConfig(), planned, choice({}, false)).custom).toBe(false);
  });
});
