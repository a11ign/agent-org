import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OTHER, VIEWER, queueingConfig, standFetch, ticket, type InstanceAnswers } from "../../test/fixtures.ts";
import { A11_312, palette, searchFor, searching, standOf } from "../search/search-harness.tsx";
import { HANDOFF_MEMORY, NOT_A_HANDOFF } from "../search/search-memory.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { TicketsPage } from "./TicketsPage.tsx";
import { bar, keysShown, textOf } from "./tickets-harness.tsx";

// A11-387: a ticket opened from the "Search tickets" palette arrives on the Tickets page ticked and ready to queue, with the banner that says why the view moved.

const FLEET = [ticket({ key: "A11-40", project: "screenreader-fleet" }), ticket({ key: "A11-41", project: "screenreader-fleet", assignee: OTHER })];
const AGENT_ORG = [A11_312, ticket({ key: "A11-300", project: "agent-org", assignee: VIEWER })];

/** An instance that reads a project at a time and searches, with screenreader-fleet and agent-org to pick. */
function byProject(more: InstanceAnswers = {}): InstanceAnswers {
  return searching(() => [A11_312], [], {
    config: queueingConfig({ projects: true, search: true, scopes: false } as never), tickets: [FLEET[0]],
    projects: [{ id: "p-fleet", name: "screenreader-fleet" }, { id: "p-agent", name: "agent-org" }],
    pages: { "project:screenreader-fleet": [{ tickets: FLEET, next: null }], "project:agent-org": [{ tickets: AGENT_ORG, next: null }] } as never,
    ...more,
  }).instance;
}

/** An instance with no project picker: it lists its tickets at once, A11-312 among them. */
const flat = (): InstanceAnswers => searching(() => [A11_312], [], { config: queueingConfig({ search: true } as never), tickets: [AGENT_ORG[1], A11_312] }).instance;

/** The Tickets page in the shell over `instance`; resolves once the list is drawn. */
async function ticketsOn(instance: InstanceAnswers) {
  // The Backlog section open, as the board draws it.
  localStorage.setItem("ticket-mode.open", JSON.stringify(["Backlog"]));
  const view = render(
    <ShellProvider fetchWith={standFetch(standOf(instance))}>
      <ShellFrame page="tickets"><TicketsPage /></ShellFrame>
    </ShellProvider>,
  );
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading tickets" })).toBeNull());
  return view;
}

const projectsGroup = () => document.querySelector<HTMLElement>(".filter-group-projects")!;
const pressedProject = () => within(projectsGroup()).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => textOf(button.querySelector(".filter-label")));
const assignee = () => screen.getByRole("group", { name: "Assignee" });
const pressedScope = () => within(assignee()).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => textOf(button).replace(/\d+$/, ""));
const banner = () => document.querySelector<HTMLElement>(".from-search-banner");
const ticked = (key: string) => (screen.getByLabelText(`Select ${key}`) as HTMLInputElement).checked;

/** On screenreader-fleet, scope Mine: where the person searches from. */
async function onFleetMine(instance: InstanceAnswers = byProject()) {
  localStorage.setItem("ticket-mode.project", JSON.stringify(["screenreader-fleet"]));
  history.replaceState(null, "", "/tickets");
  const view = await ticketsOn(instance);
  await waitFor(() => expect(keysShown()).toEqual(["A11-40", "A11-41"]));
  fireEvent.click(within(assignee()).getByRole("button", { name: /^Mine/ }));
  expect(pressedScope()).toEqual(["Mine"]);
  return view;
}

/** Opens A11-312 from the palette. */
async function openFromPalette() {
  await searchFor("worktree");
  fireEvent.click(within(palette()).getByRole("button", { name: "Open ticket" }));
}

describe("a ticket opened from the palette", () => {
  it("moves Tickets to its project and to Anyone, ticks it alone with Queue 1 ticket ready, and says why in an indigo banner", async () => {
    await onFleetMine();
    await openFromPalette();
    await waitFor(() => expect(keysShown()).toContain("A11-312"));
    expect(pressedProject()).toEqual(["agent-org"]);
    expect(pressedScope()).toEqual(["Anyone"]);
    expect(ticked("A11-312")).toBe(true);
    expect(within(bar()).getByRole("button", { name: "Queue 1 ticket" })).toBeTruthy();
    expect(banner()?.getAttribute("role")).toBe("status");
    expect(textOf(banner())).toBe("Showing A11-312 from search. It is in agent-org and unassigned, so it sits outside Mine. Everyone's tickets are shown here.Back to my tickets");
  });

  it("goes back to the project and the scope the person came from on Back to my tickets", async () => {
    await onFleetMine();
    await openFromPalette();
    await waitFor(() => expect(banner()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Back to my tickets" }));
    await waitFor(() => expect(pressedProject()).toEqual(["screenreader-fleet"]));
    expect(pressedScope()).toEqual(["Mine"]);
    expect(banner()).toBeNull();
  });

  it("puts back the ticks it replaced on Back to my tickets", async () => {
    await onFleetMine();
    fireEvent.click(screen.getByLabelText("Select A11-40"));
    await openFromPalette();
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(within(bar()).getByRole("button", { name: "Queue 1 ticket" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to my tickets" }));
    await waitFor(() => expect(pressedProject()).toEqual(["screenreader-fleet"]));
    expect(ticked("A11-40")).toBe(true);
    expect(within(bar()).getByRole("button", { name: "Queue 1 ticket" })).toBeTruthy();
  });

  it("queues the searched ticket on the default run options, not on options chosen for the batch before", async () => {
    await onFleetMine();
    fireEvent.click(screen.getByLabelText("Select A11-40"));
    fireEvent.click(screen.getByRole("button", { name: "Run options" }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "Run options" })).getByLabelText("Model"), { target: { value: "opus" } });
    expect(screen.getByText(/^Custom/)).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await openFromPalette();
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(screen.queryByText(/^Custom/)).toBeNull();
  });

  it.each([
    ["project", () => fireEvent.click(within(projectsGroup()).getByRole("button", { name: /^screenreader-fleet/ }))],
    ["scope", () => fireEvent.click(within(assignee()).getByRole("button", { name: /^Unassigned/ }))],
    ["selection", () => fireEvent.click(screen.getByLabelText("Select A11-300"))],
  ] as const)("drops the banner when the %s changes", async (_change, change) => {
    await onFleetMine();
    await openFromPalette();
    await waitFor(() => expect(banner()).not.toBeNull());
    change();
    await waitFor(() => expect(banner()).toBeNull());
  });
});

describe("a ticket handed over", () => {
  it("only ticks the row and shows the banner on an instance with no project picker", async () => {
    history.replaceState(null, "", "/tickets");
    await ticketsOn(flat());
    await openFromPalette();
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(ticked("A11-312")).toBe(true);
    expect(pressedProject()).toEqual(["agent-org"]);
    expect(textOf(banner())).toContain("It is in agent-org and unassigned");
  });

  it("ticks nothing and shows no banner when Tickets loads again after taking it", async () => {
    history.replaceState(null, "", "/tickets");
    const first = await ticketsOn(flat());
    await openFromPalette();
    await waitFor(() => expect(banner()).not.toBeNull());
    first.unmount();
    await ticketsOn(flat());
    await waitFor(() => expect(keysShown()).toContain("A11-300"));
    expect(banner()).toBeNull();
    expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull();
  });

  it("is handed to Tickets by a page load from any other page, and taken once", async () => {
    history.replaceState(null, "", "/runs");
    const runs = render(
      <ShellProvider fetchWith={standFetch(standOf(flat()))}>
        <ShellFrame page="runs"><div /></ShellFrame>
      </ShellProvider>,
    );
    await openFromPalette();
    expect(location.pathname).toBe("/tickets");
    expect(localStorage.getItem(HANDOFF_MEMORY)).toContain('"key":"A11-312"');
    runs.unmount();
    await ticketsOn(flat());
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(ticked("A11-312")).toBe(true);
    expect(localStorage.getItem(HANDOFF_MEMORY)).toBeNull();
  });

  it("is not acted on once it has expired", async () => {
    localStorage.setItem(HANDOFF_MEMORY, JSON.stringify({ key: "A11-312", project: "agent-org", assignee: null, fromProject: null, fromScope: "you", fromScopeName: "Mine", expires: Date.now() - 1 }));
    history.replaceState(null, "", "/tickets");
    await ticketsOn(flat());
    await waitFor(() => expect(keysShown()).toContain("A11-300"));
    expect(banner()).toBeNull();
    expect(localStorage.getItem(HANDOFF_MEMORY)).toBeNull();
  });

  it.each([
    ["is not JSON", "{not json", `what this browser kept under ${HANDOFF_MEMORY} is not JSON`],
    ["is not a ticket", JSON.stringify({ key: 312 }), NOT_A_HANDOFF],
  ])("says so, ticks nothing and clears it when what was handed over %s", async (_what, kept, reason) => {
    localStorage.setItem(HANDOFF_MEMORY, kept);
    history.replaceState(null, "", "/tickets");
    await ticketsOn(flat());
    await waitFor(() => expect(keysShown()).toContain("A11-300"));
    expect(screen.getByText(`The ticket opened from search could not be read: ${reason}. Open it from search again.`).closest("[role=status]")).not.toBeNull();
    expect(banner()).toBeNull();
    expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull();
    expect(localStorage.getItem(HANDOFF_MEMORY)).toBeNull();
  });
});
