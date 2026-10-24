import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HERE, PERSONAL, standFetch, ticket, type InstanceAnswers, type Stand } from "../../test/fixtures.ts";
import type { TicketView } from "../api/types.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { answers, BACKLOG, bar, keysShown, rowOf, textOf, tick } from "./tickets-harness.tsx";
import { TicketsPage } from "./TicketsPage.tsx";

// The Instance unreachable board: an SSH connection the proxy cannot reach shows the last tickets it read beneath the board's alert, with Check now. A local connection's failure never does.

const REFUSAL = "cannot reach personal over SSH: agents: Permission denied (publickey).";
const KEPT_AT = "2026-10-24T10:00:00.000Z";

/** The instance of an SSH connection that can be taken down: while `link.down` is set the queue read (and so the pill) finds it unreachable. */
function flaky(tickets: readonly TicketView[] = BACKLOG) {
  const link = { down: false, tickets };
  // Getters, not a spread of them, which would read each once.
  const instance: InstanceAnswers = {
    config: answers().config, queue: answers().queue, writer: answers().writer, post: () => ({ ok: true }),
    get tickets() { return link.tickets; },
    get queueFails() { return link.down ? { status: 502, error: REFUSAL } : undefined; },
  };
  return { link, instance };
}

async function pageOn(stand: Stand, connection = "personal") {
  history.replaceState(null, "", `/next/tickets?connection=${connection}`);
  const fetchWith = standFetch(stand);
  const view = render(<ShellProvider fetchWith={fetchWith}><ShellFrame page="tickets"><TicketsPage /></ShellFrame></ShellProvider>);
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading tickets" })).toBeNull());
  return { ...view, fetchWith };
}

/** The window gains focus: the polls read at once, as they do when a person returns to the page. */
const refocus = () => act(async () => { window.dispatchEvent(new Event("focus")); });
const readsOf = (fetchWith: ReturnType<typeof standFetch>, path: string) => fetchWith.paths.filter((read) => read === path).length;

/** The page with Backlog open, then the connection goes down and the page notices. */
async function pageGoingDown() {
  const { link, instance } = flaky();
  const page = await pageOn({ connections: [HERE, PERSONAL], instances: { personal: instance, here: answers() } });
  fireEvent.click(await screen.findByRole("button", { name: "Expand Backlog" }));
  link.down = true;
  await refocus();
  await screen.findByText("Can't reach personal over SSH.");
  return { ...page, link };
}

describe("an SSH connection that becomes unreachable", () => {
  it("shows the board's alert with the backend's sentence, what the page keeps doing, and Check now and Switch to this machine", async () => {
    await pageGoingDown();
    const alert = screen.getByRole("alert");
    expect(textOf(alert)).toContain(REFUSAL);
    expect(textOf(alert)).toContain("Atomaut keeps trying: after 2 seconds, then less often, up to once a minute. The tickets below are the last ones it saw, and queueing is paused until it reconnects.");
    expect(within(alert).getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Switch to this machine" })).toBeTruthy();
  });

  it("shows the Last known pill beside the count, and the last tickets read, with no age on screen", async () => {
    await pageGoingDown();
    expect(textOf(document.querySelector(".page-header-title"))).toMatch(/Tickets.*3 assigned to you.*Last known/);
    expect(keysShown()).toEqual(["A11-1", "A11-2", "A11-3"]);
    expect(document.body.textContent).not.toMatch(/\bago\b|read at|\d{4}-\d{2}-\d{2}T/i);
  });

  it("pauses queueing: the checkboxes, Queue, Grill, Queue its children and New ticket are disabled, and the rows are the board's paused ones", async () => {
    const { link, instance } = flaky([
      ...BACKLOG,
      ticket({ key: "A11-4", title: "A parent", children: ["A11-5"] } as never),
      ticket({ key: "A11-6", title: "Needs a decision", needsDecision: { kind: "open", reason: "Two readings" } } as never),
    ]);
    await pageOn({ connections: [HERE, PERSONAL], instances: { personal: instance, here: answers() } });
    fireEvent.click(await screen.findByRole("button", { name: "Expand Backlog" }));
    tick("A11-1");
    expect((within(bar()).getByRole("button", { name: "Queue 1 ticket" }) as HTMLButtonElement).disabled).toBe(false);
    link.down = true;
    await refocus();
    await screen.findByText("Can't reach personal over SSH.");
    expect((within(bar()).getByRole("button", { name: "Queue 1 ticket" }) as HTMLButtonElement).disabled).toBe(true);
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).disabled).toBe(true);
    for (const name of ["Grill", "Queue its children"]) for (const button of screen.getAllByRole("button", { name })) expect((button as HTMLButtonElement).disabled).toBe(true);
    const newTicket = screen.getByRole("button", { name: "New ticket" }) as HTMLButtonElement;
    expect(newTicket.disabled).toBe(true);
    expect(newTicket.title).toBe("Paused until personal is reachable");
    expect(document.querySelector(".ticket-section-paused")).toBeTruthy();
    expect(rowOf("A11-2").closest(".ticket-section-paused")).toBeTruthy();
  });

  it("returns to live data when Check now succeeds: the alert and the pill go, the reconnected banner shows, and the tickets are read again", async () => {
    const { fetchWith, link } = await pageGoingDown();
    const before = readsOf(fetchWith, "/c/personal/api/tickets");
    link.down = false;
    link.tickets = [...BACKLOG, ticket({ key: "A11-9", title: "Filed while it was away" })];
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(screen.queryByText("Can't reach personal over SSH.")).toBeNull());
    expect(textOf(document.querySelector(".reconnected-banner"))).toBe("personal is reached over SSH again. Showing live tickets.");
    expect(screen.queryByText("Last known")).toBeNull();
    await waitFor(() => expect(readsOf(fetchWith, "/c/personal/api/tickets")).toBe(before + 1));
    await waitFor(() => expect(keysShown()).toEqual(["A11-1", "A11-2", "A11-3", "A11-9"]));
    expect((screen.getByRole("button", { name: "New ticket" }) as HTMLButtonElement).title).toBe("");
    expect(screen.getAllByRole("checkbox").some((box) => !(box as HTMLInputElement).disabled)).toBe(true);
  });

});

describe("Check now and Switch to this machine", () => {
  it("keeps Check now's answer to a connection that is still down: the alert stays and the tickets are not read again", async () => {
    const { fetchWith } = await pageGoingDown();
    const before = readsOf(fetchWith, "/c/personal/api/queue");
    const tickets = readsOf(fetchWith, "/c/personal/api/tickets");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(readsOf(fetchWith, "/c/personal/api/queue")).toBe(before + 1));
    expect(screen.getByText("Can't reach personal over SSH.")).toBeTruthy();
    expect(readsOf(fetchWith, "/c/personal/api/tickets")).toBe(tickets);
  });

  it("switches to this machine's instance from the alert", async () => {
    const { fetchWith } = await pageGoingDown();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Switch to this machine" }));
    await waitFor(() => expect(screen.queryByText("Can't reach personal over SSH.")).toBeNull());
    await waitFor(() => expect(fetchWith.paths).toContain("/c/here/api/tickets"));
    expect(localStorage.getItem("ticket-mode.connection")).toContain("here");
    expect(screen.queryByText("Last known")).toBeNull();
  });

  it("draws no Switch to this machine when no local connection is listed", async () => {
    const { link, instance } = flaky();
    await pageOn({ connections: [PERSONAL], instances: { personal: instance } });
    link.down = true;
    await refocus();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: "Switch to this machine" })).toBeNull();
  });
});

describe("a page opened while the connection is already unreachable", () => {
  const gone = (value: unknown) => ({ status: 502, error: REFUSAL, ...(value === undefined ? {} : { lastKnown: { value, readAt: KEPT_AT } }) });

  it("shows the last known tickets the proxy kept, with the Last known pill", async () => {
    const instance: InstanceAnswers = { configFail: gone(answers().config), ticketsFail: gone(BACKLOG), queueFails: gone({ entries: [], max: 1, paused: false }) };
    await pageOn({ connections: [HERE, PERSONAL], instances: { personal: instance } });
    await screen.findByText("Can't reach personal over SSH.");
    fireEvent.click(await screen.findByRole("button", { name: "Expand Backlog" }));
    expect(keysShown()).toEqual(["A11-1", "A11-2", "A11-3"]);
    expect(screen.getByText("Last known")).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEPT_AT);
  });

  it("shows the alert alone, with no pill, when the proxy kept nothing", async () => {
    const instance: InstanceAnswers = { configFail: gone(undefined), ticketsFail: gone(undefined), queueFails: gone(undefined) };
    await pageOn({ connections: [HERE, PERSONAL], instances: { personal: instance } });
    await screen.findByText("Can't reach personal over SSH.");
    expect(screen.queryByText("Last known")).toBeNull();
    expect(keysShown()).toEqual([]);
  });

  it("returns to live data once the connection answers again", async () => {
    const link = { down: true };
    const live = answers([...BACKLOG, ticket({ key: "A11-9", title: "Live" })]);
    const instance: InstanceAnswers = {
      config: live.config, tickets: live.tickets, queue: live.queue, writer: live.writer,
      get configFail() { return link.down ? gone(answers().config) : undefined; },
      get ticketsFail() { return link.down ? gone(BACKLOG) : undefined; },
      get queueFails() { return link.down ? gone({ entries: [], max: 1, paused: false }) : undefined; },
    };
    await pageOn({ connections: [HERE, PERSONAL], instances: { personal: instance } });
    await screen.findByText("Can't reach personal over SSH.");
    link.down = false;
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(screen.queryByText("Can't reach personal over SSH.")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Expand Backlog" }));
    await waitFor(() => expect(keysShown()).toEqual(["A11-1", "A11-2", "A11-3", "A11-9"]));
  });
});

describe("a failure that is not an unreachable SSH connection", () => {
  it("is the error banner with Retry for a local connection, and never the Last known pill, Check now or the unreachable alert", async () => {
    const instance: InstanceAnswers = { ...answers(), ticketsFail: { status: 500, error: "tracker refused" }, queueFails: { status: 500, error: "tracker refused" } };
    await pageOn({ connections: [HERE], instances: { here: instance } }, "here");
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("tracker refused");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Last known")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });

  it("is not unreachable for a local connection whose reads say they cannot reach it, as the proxy words a restart", async () => {
    const instance: InstanceAnswers = { ...answers(), queueFails: { status: 502, error: REFUSAL }, ticketsFail: { status: 502, error: REFUSAL } };
    const { fetchWith } = await pageOn({ connections: [HERE], instances: { here: instance } }, "here");
    await waitFor(() => expect(readsOf(fetchWith, "/c/here/api/queue")).toBeGreaterThan(0));
    await refocus();
    expect(screen.queryByText("Last known")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });
});
