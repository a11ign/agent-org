import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OTHER, queueOf, standFetch, ticket, type InstanceAnswers } from "../../test/fixtures.ts";
import type { QueueView } from "../api/types.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { answers, BACKLOG, bar, keysShown, openPage, pageOn, standOf, textOf, tick } from "./tickets-harness.tsx";
import { TicketsPage } from "./TicketsPage.tsx";

describe("the states", () => {
  it("is the board's skeleton while the tickets load, with the header and the filters already drawn", async () => {
    render(<ShellProvider fetchWith={standFetch({ ...standOf(), holdInstance: true })}><ShellFrame page="tickets"><TicketsPage /></ShellFrame></ShellProvider>);
    const skeleton = await screen.findByRole("status", { name: "Loading tickets" });
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.querySelectorAll(".skeleton-panel-row")).toHaveLength(8);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Tickets");
    expect(screen.getByPlaceholderText("Filter by key, title or project")).toBeTruthy();
    expect(document.querySelector(".page-header .sk")).toBeTruthy();
  });

  it("is the empty panel when nothing is assigned to you, and Show anyone's tickets chooses Anyone", async () => {
    const elsewhere = [ticket({ key: "A11-9", title: "Someone else's", assignee: OTHER })];
    await pageOn(standOf(answers(elsewhere)));
    expect(screen.getByText("Nothing is assigned to you")).toBeTruthy();
    expect(screen.getByText("Describe what you need and the ticket writer will file it. Or look at tickets assigned to anyone, or to no one.")).toBeTruthy();
    expect(textOf(document.querySelector(".page-count"))).toBe("0 assigned to you");
    const buttons = screen.getAllByRole("button", { name: "New ticket" }) as HTMLButtonElement[];
    expect(buttons.length).toBe(2);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    fireEvent.click(buttons[1] as HTMLButtonElement);
    expect(screen.getByRole("dialog", { name: "New ticket" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Show anyone's tickets" }));
    expect(screen.queryByText("Nothing is assigned to you")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Expand Backlog" }));
    expect(keysShown()).toEqual(["A11-9"]);
    expect(within(screen.getByRole("group", { name: "Assignee" })).getByRole("button", { name: /^Anyone/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says why another scope holds none, with no buttons", async () => {
    await pageOn(standOf(answers([ticket({ key: "A11-1" })])));
    fireEvent.click(screen.getByRole("button", { name: "Unassigned" }));
    expect(screen.getByText("Nothing is unassigned")).toBeTruthy();
    expect(screen.getByText(/No open ticket is unassigned/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show anyone's tickets" })).toBeNull();
  });

  it("gives the instance's own sentence when it lists no ticket at all", async () => {
    const pick = { empty: "No open tickets are assigned to Me, whose Linear key this board reads with." };
    const { fetchWith } = await pageOn(standOf(answers([], { pick })));
    expect(await screen.findByText(pick.empty)).toBeTruthy();
    expect(fetchWith.paths).toContain("/c/here/api/pick");
    expect(screen.queryByRole("button", { name: "Show anyone's tickets" })).toBeNull();
  });

  it("falls back to a plain line when the instance cannot say why", async () => {
    await pageOn(standOf(answers([])));
    expect(await screen.findByText("No open tickets to list.")).toBeTruthy();
  });

});

describe("the paused, error and unreachable states", () => {
  it("is the paused banner, with a link to start workers on Runs, above the list", async () => {
    await openPage(standOf(answers(BACKLOG, { queue: { ...queueOf(), paused: true } as unknown as QueueView })));
    const banner = screen.getByText("Workers are paused. Tickets you queue wait until you start workers.");
    expect(banner.closest("[role=status]")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start workers on Runs" }).getAttribute("href")).toBe("/runs");
  });

  it("has no paused banner while workers run", async () => {
    await openPage();
    expect(screen.queryByText(/Workers are paused/)).toBeNull();
  });

  it("is the error banner with the server's sentence, Retry reading again, and Dismiss hiding it until the next failure", async () => {
    let failing = true;
    const instance = { ...answers(), get ticketsFail() { return failing ? { status: 500, error: "tracker refused" } : undefined; } };
    const { fetchWith } = await pageOn(standOf(instance));
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("tracker refused");
    expect(screen.queryByRole("button", { name: "Expand Backlog" })).toBeNull();
    failing = false;
    const reads = fetchWith.paths.filter((path) => path === "/c/here/api/tickets").length;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchWith.paths.filter((path) => path === "/c/here/api/tickets").length).toBe(reads + 1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByRole("button", { name: "Expand Backlog" })).toBeTruthy();
  });

  it("hides the error banner with Dismiss", async () => {
    await pageOn(standOf({ ...answers(), ticketsFail: { status: 500, error: "tracker refused" } }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says an SSH instance cannot be reached, in the shell's frame, when its first read fails", async () => {
    const ssh = { name: "personal", kind: "ssh" } as const;
    const instance = { ...answers(), ticketsFail: { status: 502, error: "cannot reach personal: ssh: timed out" } };
    render(<ShellProvider fetchWith={standFetch({ connections: [ssh], instances: { personal: instance } })}><ShellFrame page="tickets"><TicketsPage /></ShellFrame></ShellProvider>);
    const frame = await screen.findByText("Can't reach personal over SSH.");
    expect(textOf(frame.closest("[role=alert]"))).toContain("cannot reach personal: ssh: timed out");
    expect(screen.queryByRole("button", { name: "Expand Backlog" })).toBeNull();
  });

  it("keeps the last good list beneath the frame when a later read finds the instance unreachable", async () => {
    const ssh = { name: "personal", kind: "ssh" } as const;
    let down = false;
    const instance: InstanceAnswers = { ...answers(BACKLOG, { post: () => ({ status: 409, error: "refused" }) }), get ticketsFail() { return down ? { status: 502, error: "cannot reach personal: ssh: timed out" } : undefined; } };
    render(<ShellProvider fetchWith={standFetch({ connections: [ssh], instances: { personal: instance } })}><ShellFrame page="tickets"><TicketsPage /></ShellFrame></ShellProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Expand Backlog" }));
    tick("A11-1");
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    down = true;
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Can't reach personal over SSH.")).toBeTruthy();
    expect(keysShown()).toEqual(["A11-1", "A11-2", "A11-3"]);
  });
});

describe("the queue not being read yet", () => {
  it("keeps the skeleton until it has, so no ticket already on the queue can be picked meanwhile", async () => {
    render(<ShellProvider fetchWith={standFetch({ ...standOf(), holdQueue: true })}><ShellFrame page="tickets"><TicketsPage /></ShellFrame></ShellProvider>);
    expect(await screen.findByRole("status", { name: "Loading tickets" })).toBeTruthy();
    await new Promise((done) => setTimeout(done, 100));
    expect(screen.getByRole("status", { name: "Loading tickets" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Expand Backlog" })).toBeNull();
  });
});
