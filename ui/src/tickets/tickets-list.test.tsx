import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { OTHER, queueingConfig, queueOf, ticket } from "../../test/fixtures.ts";
import type { QueueView } from "../api/types.ts";
import { answers, BACKLOG, bar, keysShown, openPage, pageOn, rowOf, standOf, textOf, tick } from "./tickets-harness.tsx";

describe("the list", () => {
  it("is one section per status with its count, closed at first so a first visit sees every status", async () => {
    await pageOn(standOf(answers([...BACKLOG, ticket({ key: "A11-4", status: "In Progress", statusOrder: 2 })])));
    const sections = screen.getAllByRole("region").filter((region) => region.classList.contains("ticket-section"));
    expect(sections.map((section) => textOf(section))).toEqual(["Backlog3", "In Progress1"]);
    expect(keysShown()).toEqual([]);
  });

  it("opens a section, and remembers it under ticket-mode.open for the next visit", async () => {
    const { unmount } = await openPage();
    expect(keysShown()).toEqual(["A11-1", "A11-2", "A11-3"]);
    expect(JSON.parse(localStorage.getItem("ticket-mode.open") ?? "[]")).toEqual(["Backlog"]);
    unmount();
    await pageOn(standOf());
    expect(keysShown()).toEqual(["A11-1", "A11-2", "A11-3"]);
  });

  it("draws a row as the board does: the checkbox, the priority, the key, the title linked to the tracker, the goal and the project", async () => {
    await openPage();
    const row = rowOf("A11-1");
    expect(within(row).getByLabelText("Select A11-1")).toBeTruthy();
    expect(within(row).getByRole("img", { name: "Urgent" })).toBeTruthy();
    expect(textOf(row.querySelector(".row-key"))).toBe("A11-1");
    const link = within(row).getByRole("link", { name: "Fix the fleet" });
    expect(link.getAttribute("href")).toBe("https://tracker.example/A11-1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(textOf(row.querySelector(".pill-tag"))).toBe("Fleet");
    expect(textOf(row.querySelector(".row-project"))).toBe("a11ign");
  });

  it("names a ticket's priority by its name, and 'No priority' for none", async () => {
    await openPage();
    expect(within(rowOf("A11-2")).getByRole("img", { name: "Medium" })).toBeTruthy();
    expect(within(rowOf("A11-3")).getByRole("img", { name: "No priority" })).toBeTruthy();
  });

  it("draws a title as text when the tracker gave no address, or one that is not http", async () => {
    await openPage(standOf(answers([ticket({ key: "A11-1", title: "No link", url: "" }), ticket({ key: "A11-2", title: "Script", url: "javascript:alert(1)" })])));
    expect(within(rowOf("A11-1")).queryByRole("link")).toBeNull();
    expect(within(rowOf("A11-2")).queryByRole("link")).toBeNull();
  });

});

describe("filtering and folding the list", () => {
  it("says how many it shows of how many the project holds in the status", async () => {
    await openPage();
    expect(textOf(document.querySelector(".section-foot"))).toBe("Showing 3 of 3 backlog tickets");
    fireEvent.change(screen.getByPlaceholderText("Filter by key, title or project"), { target: { value: "fleet" } });
    expect(keysShown()).toEqual(["A11-1"]);
    expect(textOf(document.querySelector(".section-foot"))).toBe("Showing 1 of 3 backlog tickets");
    expect(textOf(document.querySelector(".section-count"))).toBe("3");
  });

  it("keeps the section when the filters leave none, and says so", async () => {
    await openPage();
    fireEvent.change(screen.getByPlaceholderText("Filter by key, title or project"), { target: { value: "nothing matches this" } });
    expect(screen.getByText("No tickets match this filter.")).toBeTruthy();
    expect(textOf(document.querySelector(".section-foot"))).toBe("Showing 0 of 3 backlog tickets");
  });

  it("collapses a section again, and Expand all and Collapse all open and close every section", async () => {
    await pageOn(standOf(answers([...BACKLOG, ticket({ key: "A11-4", status: "In Progress", statusOrder: 2 })])));
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(keysShown()).toHaveLength(4);
    expect(JSON.parse(localStorage.getItem("ticket-mode.open") ?? "[]").sort()).toEqual(["Backlog", "In Progress"]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(keysShown()).toEqual([]);
    expect(JSON.parse(localStorage.getItem("ticket-mode.open") ?? "[]")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Expand Backlog" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Backlog" }));
    expect(keysShown()).toEqual([]);
  });

  it("counts the project's tickets in the scope, and what they are, beside the heading", async () => {
    await pageOn(standOf());
    expect(textOf(document.querySelector(".page-count"))).toBe("3 assigned to you");
  });

  it("has a New ticket button that is present and disabled until the dialog lands, and none where the instance writes no tickets", async () => {
    const { unmount } = await pageOn(standOf());
    expect((screen.getByRole("button", { name: "New ticket" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    await pageOn(standOf(answers(BACKLOG, { config: queueingConfig({ writer: false }) })));
    expect(screen.queryByRole("button", { name: "New ticket" })).toBeNull();
  });
});

describe("the row variants", () => {
  const tickets = [
    ticket({ key: "A11-1", title: "Plain" }),
    ticket({ key: "A11-2", title: "Needs a ruling", needsDecision: { kind: "open", reason: "Two readings of the ticket" }, goals: ["Fleet"] } as never),
    ticket({ key: "A11-3", title: "Already queued" }),
    ticket({ key: "A11-4", title: "Held elsewhere", taken: "work" } as never),
    ticket({ key: "A11-5", title: "An epic", children: ["A11-8", "A11-9"] } as never),
  ];
  const queue = { ...queueOf("finished"), paused: false, entries: [{ ticket: { key: "A11-3" }, phase: "finished" }] } as unknown as QueueView;

  it("shows an open decision as a pill with its reason and a Grill button in place of the goal", async () => {
    await openPage(standOf(answers(tickets, { queue })));
    const row = rowOf("A11-2");
    expect(within(row).getByText("Needs a decision").getAttribute("title")).toBe("Two readings of the ticket");
    expect(within(row).getByRole("button", { name: "Grill" })).toBeTruthy();
    expect(within(row).queryByText("Fleet")).toBeNull();
    expect((within(row).getByLabelText("Select A11-2") as HTMLInputElement).disabled).toBe(true);
  });

  it("dims a ticket on the queue, says which phase, and does not let it be picked", async () => {
    await openPage(standOf(answers(tickets, { queue })));
    const row = rowOf("A11-3");
    expect(row.classList.contains("row-dim")).toBe(true);
    expect(within(row).getByText("On the queue: finished")).toBeTruthy();
    expect((within(row).getByLabelText("Select A11-3") as HTMLInputElement).disabled).toBe(true);
  });

  it("says which instance holds a ticket another instance took, without dimming it", async () => {
    await openPage(standOf(answers(tickets, { queue })));
    const row = rowOf("A11-4");
    expect(within(row).getByText("Taken: work")).toBeTruthy();
    expect(row.classList.contains("row-dim")).toBe(false);
    expect((within(row).getByLabelText("Select A11-4") as HTMLInputElement).disabled).toBe(true);
  });

  it("offers an epic's children with Queue its children, and no checkbox to queue the epic itself", async () => {
    await openPage(standOf(answers(tickets, { queue })));
    const row = rowOf("A11-5");
    expect(within(row).getByText("Parent · 2 open sub-issues")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Queue its children" })).toBeTruthy();
    expect((within(row).getByLabelText("Select A11-5") as HTMLInputElement).disabled).toBe(true);
  });

  it("names the owner on every row once the scope is not the signed-in person's own", async () => {
    await openPage(standOf(answers([ticket({ key: "A11-1" }), ticket({ key: "A11-2", assignee: OTHER }), ticket({ key: "A11-3", assignee: null })])));
    expect(within(rowOf("A11-1")).queryByText("Me")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Anyone/ }));
    expect(within(rowOf("A11-1")).getByText("Me")).toBeTruthy();
    expect(within(rowOf("A11-2")).getByText("Someone")).toBeTruthy();
    expect(within(rowOf("A11-3")).getByText("Unassigned")).toBeTruthy();
  });
});

describe("a parent with tickets under it", () => {
  const epic = ticket({ key: "A11-10", title: "The epic", children: ["A11-11", "A11-12"] } as never);
  const tickets = [epic, ticket({ key: "A11-11", title: "First part", parent: "A11-10" }), ticket({ key: "A11-12", title: "Second part", parent: "A11-10", status: "In Progress", statusOrder: 2 })];

  it("folds its tickets away, opens them indented with their own status, and remembers the fold under ticket-mode.open-parents", async () => {
    await openPage(standOf(answers(tickets)));
    expect(keysShown()).toEqual(["A11-10"]);
    fireEvent.click(screen.getByRole("button", { name: "Expand A11-10" }));
    expect(keysShown()).toEqual(["A11-10", "A11-11", "A11-12"]);
    expect(rowOf("A11-12").style.getPropertyValue("--depth")).toBe("1");
    expect(within(rowOf("A11-12")).getByText("In Progress")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("ticket-mode.open-parents") ?? "[]")).toEqual(["A11-10"]);
  });

  it("picks the tickets under it with its own checkbox, part ticked when only some are", async () => {
    await openPage(standOf(answers(tickets)));
    fireEvent.click(screen.getByRole("button", { name: "Expand A11-10" }));
    const box = screen.getByLabelText("Select the tickets under A11-10") as HTMLInputElement;
    fireEvent.click(box);
    expect((screen.getByLabelText("Select A11-11") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Select A11-12") as HTMLInputElement).checked).toBe(true);
    expect(box.checked).toBe(true);
    tick("A11-12");
    expect(box.checked).toBe(false);
    expect(box.indeterminate).toBe(true);
  });

  it("says a parent outside the person's tickets is not in this view", async () => {
    const outside = ticket({ key: "A11-10", title: "Someone's epic", assignee: OTHER, children: ["A11-11"] } as never);
    await openPage(standOf(answers([outside, ticket({ key: "A11-11", title: "My part", parent: "A11-10" })])));
    expect(within(rowOf("A11-10")).getByText("Not in this view")).toBeTruthy();
  });

  it("reads the parents the instance names after the first list, so a child keeps its epic whatever the scope", async () => {
    const stand = standOf(answers([ticket({ key: "A11-11", title: "My part", parent: "A11-10" })], { parents: [ticket({ key: "A11-10", title: "Elsewhere", assignee: OTHER, children: ["A11-11"] } as never)] }));
    const { fetchWith } = await pageOn(stand);
    await waitFor(() => expect(fetchWith.paths).toContain("/c/here/api/parents"));
    fireEvent.click(await screen.findByRole("button", { name: "Expand Backlog" }));
    expect(within(rowOf("A11-10")).getByText("Not in this view")).toBeTruthy();
  });
});

describe("selecting", () => {
  it("ticks a row, shows the queue bar with the count, and Clear takes it away", async () => {
    await openPage();
    expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull();
    tick("A11-1");
    tick("A11-2");
    expect(textOf(bar())).toContain("2 selected");
    expect(within(bar()).getByRole("button", { name: "Queue 2 tickets" })).toBeTruthy();
    fireEvent.click(within(bar()).getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull();
  });

  it("says 'Queue 1 ticket' for one", async () => {
    await openPage();
    tick("A11-1");
    expect(within(bar()).getByRole("button", { name: "Queue 1 ticket" })).toBeTruthy();
  });

  it("picks every ticket a section can pick with Select all shown, and none again", async () => {
    await openPage(standOf(answers([...BACKLOG, ticket({ key: "A11-4", title: "Epic", children: ["A11-5"] } as never)])));
    const all = screen.getByLabelText("Select all shown in Backlog") as HTMLInputElement;
    fireEvent.click(all);
    expect(textOf(bar())).toContain("3 selected");
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull();
  });

  it("tints a ticked row", async () => {
    await openPage();
    tick("A11-1");
    expect(rowOf("A11-1").classList.contains("row-picked")).toBe(true);
  });
});
