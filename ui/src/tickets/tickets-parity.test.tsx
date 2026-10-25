import { ticket } from "../../test/fixtures.ts";
import type { QueueView } from "../api/types.ts";
import { fireEvent, screen, within } from "@testing-library/react";
import { answers, openPage, rowOf, standOf, textOf } from "./tickets-harness.tsx";

// What `ui.html`'s Pick tab shows that A11-196's page left off (A11-220): the held notice, the label tags of a row, the no-plan mark, and the count under a parent.

const HELD = { name: "tickets.preflight", reason: "the disk is 97% full", since: 0 };
const queueHolding = (held: typeof HELD | null): QueueView => ({ entries: [], max: 3, paused: false, held }) as unknown as QueueView;

describe("the held notice", () => {
  it("says which check holds every run, above the list, as it does on Runs", async () => {
    await openPage(standOf(answers(undefined, { queue: queueHolding(HELD) })));
    const banner = screen.getByText("No run starts while tickets.preflight fails: the disk is 97% full");
    expect(banner.closest("[role=status]")).not.toBeNull();
    const list = screen.getByRole("region", { name: "Backlog" });
    expect(banner.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is not drawn while no run is held", async () => {
    await openPage(standOf(answers(undefined, { queue: queueHolding(null) })));
    expect(screen.queryByText(/^No run starts while/)).toBeNull();
  });
});

describe("a row's label tags", () => {
  const labelled = ticket({
    key: "A11-30", title: "A labelled ticket", goals: ["Fleet"],
    labels: [{ name: "Bug", group: "Type" }, { name: "Windows", group: "Area" }, { name: "loose", group: null }],
  });

  it("writes each label of a group after the title, titled with its group", async () => {
    await openPage(standOf(answers([labelled])));
    const tags = [...rowOf("A11-30").querySelectorAll<HTMLElement>(".label-tag")];
    expect(tags.map((tag) => [textOf(tag), tag.title])).toEqual([["Windows", "Area"], ["Bug", "Type"]]);
  });

  it("leaves out the Goal label, which the goal pill shows, and a label in no group", async () => {
    await openPage(standOf(answers([labelled])));
    const row = rowOf("A11-30");
    expect([...row.querySelectorAll(".label-tag")].map(textOf)).not.toContain("Fleet");
    expect([...row.querySelectorAll(".label-tag")].map(textOf)).not.toContain("loose");
    expect(within(row).getByText("Fleet")).toBeTruthy();
  });

  it("draws none on a ticket with no label", async () => {
    await openPage(standOf(answers([ticket({ key: "A11-31", title: "Plain" })])));
    expect(rowOf("A11-31").querySelector(".label-tag")).toBeNull();
  });
});

describe("the no-plan mark", () => {
  it("marks a ticket with no plan of its own, with the board's note", async () => {
    await openPage(standOf(answers([ticket({ key: "A11-40", title: "Unplanned" })])));
    const mark = within(rowOf("A11-40")).getByRole("img", { name: "No plan attached. Attach one before a worker starts this." });
    expect(mark.className).toBe("no-plan");
  });

  it("does not mark a ticket with a plan attached", async () => {
    await openPage(standOf(answers([ticket({ key: "A11-41", title: "Planned", uploads: ["plan.md"] } as never)])));
    expect(rowOf("A11-41").querySelector(".no-plan")).toBeNull();
  });

  it("mutes the mark when the parent's plan covers the ticket, and says so", async () => {
    const parent = ticket({ key: "A11-42", title: "Parent", uploads: ["plan.md"], children: ["A11-43"] } as never);
    await openPage(standOf(answers([parent, ticket({ key: "A11-43", title: "Child", parent: "A11-42" })])));
    fireEvent.click(screen.getByRole("button", { name: "Expand A11-42" }));
    const mark = within(rowOf("A11-43")).getByRole("img", { name: "No plan of its own. A worker reads its parent A11-42's plan." });
    expect(mark.className).toBe("no-plan no-plan-covered");
  });

  it("does not mark a parent, which is never started", async () => {
    const parent = ticket({ key: "A11-44", title: "Parent", children: ["A11-45"] } as never);
    await openPage(standOf(answers([parent, ticket({ key: "A11-45", title: "Child", parent: "A11-44" })])));
    expect(rowOf("A11-44").querySelector(".no-plan")).toBeNull();
  });
});

describe("a parent's count", () => {
  it("says how many tickets are under it", async () => {
    const parent = ticket({ key: "A11-50", title: "Parent", children: ["A11-51", "A11-52"] } as never);
    await openPage(standOf(answers([parent, ticket({ key: "A11-51", title: "One", parent: "A11-50" }), ticket({ key: "A11-52", title: "Two", parent: "A11-50" })])));
    expect(within(rowOf("A11-50")).getByText("2 tickets under it")).toBeTruthy();
  });

  it("says ticket, not tickets, for one", async () => {
    const parent = ticket({ key: "A11-53", title: "Parent", children: ["A11-54"] } as never);
    await openPage(standOf(answers([parent, ticket({ key: "A11-54", title: "One", parent: "A11-53" })])));
    expect(within(rowOf("A11-53")).getByText("1 ticket under it")).toBeTruthy();
  });
});
