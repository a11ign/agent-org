import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Fetch } from "../api/request.ts";
import { writerRun } from "../new-ticket/new-ticket-fixtures.ts";
import { pageOver, strips } from "../new-ticket/new-ticket-harness.tsx";
import { bell, failedRun, FILED, finished, inPanel, items, keeping, openPanel, pageIn, panel, panelOver, readAgain, REQUEST, textOf } from "./notifications-harness.tsx";

// The notification centre, as the ticket's scenarios read: the bell on every page, the panel, its items, clearing, the filters and the arrival of a request.

const TWO_DONE_ONE_FAILED = () => [finished({ id: "w1" }), finished({ id: "w2", minutes: 5 }), failedRun({ id: "w3", minutes: 9 })];

describe("the bell", () => {
  it("is named by how many finished requests are listed, shows that count as a badge, and says it is collapsed", async () => {
    await pageIn("tickets", TWO_DONE_ONE_FAILED());
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 3"));
    expect(textOf(bell().querySelector(".bell-badge"))).toBe("3");
    expect(bell().getAttribute("aria-expanded")).toBe("false");
    expect(bell().getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  it("shows no badge with nothing listed", async () => {
    await pageIn("runs", [writerRun()]);
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 0");
    expect(bell().querySelector(".bell-badge")).toBeNull();
  });

  it("does not count a request still under way", async () => {
    await pageIn("tickets", [finished(), writerRun({ id: "w2", status: "writing" }), writerRun({ id: "w3", phase: "queued", status: "queued" })]);
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1"));
  });

  it.each(["models", "runs", "tickets"] as const)("opens the same panel on the %s page, without leaving it", async (page) => {
    await pageIn(page, [finished()]);
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1"));
    openPanel();
    expect(panel()).toBeTruthy();
    expect(bell().getAttribute("aria-expanded")).toBe("true");
    expect(items().length).toBe(1);
  });

  it("closes again when pressed again", async () => {
    await pageIn("models", [finished()]);
    openPanel();
    openPanel();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(bell().getAttribute("aria-expanded")).toBe("false");
  });

  it("is first in the sidebar's focus order", async () => {
    await pageIn("tickets");
    const sidebar = screen.getByRole("complementary", { name: "Atomaut" });
    expect(sidebar.querySelector("button, a, select")).toBe(bell());
  });
});

describe("an item", () => {
  it("of a Done request that filed one ticket: Done, who wrote it, how long ago, the request, and the ticket linked", async () => {
    await panelOver([finished({ request: "Add a retry button to the unreachable banner" })]);
    const [item] = items() as HTMLElement[];
    expect(textOf(item?.querySelector(".notification-label"))).toBe("Done");
    expect(item?.querySelector(".notification-label-succeeded")).not.toBeNull();
    expect(textOf(item?.querySelector(".notification-by"))).toBe("Ticket writer · sonnet/high · Quick");
    expect(textOf(item?.querySelector(".notification-when"))).toBe("2 min ago");
    expect(textOf(item?.querySelector(".notification-text"))).toBe("Add a retry button to the unreachable banner");
    expect(textOf(item?.querySelector(".notification-made-title"))).toBe("Filed by this request");
    const link = within(item as HTMLElement).getByRole("link");
    expect(textOf(link.querySelector(".notification-ticket-key"))).toBe("A11-143");
    expect(textOf(link.querySelector(".notification-ticket-title"))).toBe(FILED.title);
    expect(link.getAttribute("href")).toBe("https://tracker.example/A11-143");
    expect(item?.querySelector(".notification-failure")).toBeNull();
    expect(item?.querySelector(".notification-chip")).toBeNull();
  });

  it("of a Done request that filed several tickets lists each as its key and a title", async () => {
    const epic = { key: "A11-150", url: "https://tracker.example/A11-150", inPick: true, title: "The epic" };
    const child = (n: number) => ({ key: `A11-15${n}`, url: null, inPick: null, title: `Child ${n}` });
    await panelOver([finished({ tickets: [epic, child(1), child(2)] })]);
    const rows = [...(items()[0] as HTMLElement).querySelectorAll(".notification-ticket")];
    expect(rows.map((row) => textOf(row))).toEqual(["A11-150The epic", "A11-151Child 1", "A11-152Child 2"]);
    expect(rows.map((row) => row.tagName)).toEqual(["A", "DIV", "DIV"]);
  });

  it("does not link a ticket whose address is not an http address", async () => {
    await panelOver([finished({ tickets: [{ ...FILED, url: "javascript:alert(1)" }] })]);
    expect(inPanel().queryByRole("link")).toBeNull();
    expect(textOf(items()[0]?.querySelector(".notification-ticket-key"))).toBe("A11-143");
  });

  it("of a Failed request shows Failed and the writer's reason in a red box, and no tickets", async () => {
    await panelOver([failedRun()]);
    const item = items()[0] as HTMLElement;
    expect(item.querySelector(".notification-label-failed")?.textContent).toBe("Failed");
    expect(item.querySelector(".notification-failure")?.textContent).toBe("The brief names no team");
    expect(item.querySelector(".notification-made")).toBeNull();
  });

  it("of a Failed request that filed a ticket first shows the reason and still lists the ticket", async () => {
    await panelOver([failedRun({ tickets: [{ ...FILED, key: "A11-160" }] })]);
    expect(items().map((item) => [".notification-failure", ".notification-made-title", ".notification-ticket-key"].map((part) => textOf(item.querySelector(part))))).toEqual([["The brief names no team", "Filed by this request", "A11-160"]]);
  });

  it("of a request stopped on the board reads Failed with the board's reason", async () => {
    await panelOver([failedRun({ failure: "stopped on the board" })]);
    expect(textOf(items()[0]?.querySelector(".notification-failure"))).toBe("stopped on the board");
  });

  it("lists the newest finished first", async () => {
    await panelOver([finished({ id: "old", minutes: 90, request: "Older" }), finished({ id: "new", minutes: 1, request: "Newer" }), failedRun({ id: "mid", minutes: 30, request: "Middle" })]);
    expect(items().map((item) => [textOf(item.querySelector(".notification-text")), textOf(item.querySelector(".notification-when"))])).toEqual([["Newer", "1 min ago"], ["Middle", "30 min ago"], ["Older", "1 h ago"]]);
  });

  it("names the button that clears it by its outcome and age", async () => {
    await panelOver([finished(), failedRun({ id: "w2", minutes: 120 })]);
    expect(inPanel().getByRole("button", { name: "Clear notification: done, 2 min ago" })).toBeTruthy();
    expect(inPanel().getByRole("button", { name: "Clear notification: failed, 2 h ago" })).toBeTruthy();
  });
});

describe("clearing one", () => {
  it("one removes that request for good: the item leaves, the badge drops, the dismiss is posted, and a reload does not bring it back", async () => {
    const { base, board, unmount } = await panelOver([finished({ id: "w1" }), failedRun({ id: "w2", minutes: 4 })]);
    fireEvent.click(inPanel().getByRole("button", { name: "Clear notification: done, 2 min ago" }));
    await waitFor(() => expect(items().length).toBe(1));
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 1");
    await waitFor(() => expect(base.requests.some(({ method, path }) => method === "POST" && path === "/c/here/api/writer/w1/dismiss")).toBe(true));
    expect(board.view.runs.map((run) => run.id)).toEqual(["w2"]);
    unmount();
    await panelOver(board.view.runs);
    expect(items().length).toBe(1);
    expect(textOf(items()[0]?.querySelector(".notification-label"))).toBe("Failed");
  });

  it("one leaves at once, even while the poll still lists it, and posts the dismiss once", async () => {
    const { base } = await panelOver([finished()], () => ({ post: () => ({ runs: [] }) }));
    const clear = inPanel().getByRole("button", { name: "Clear notification: done, 2 min ago" });
    fireEvent.click(clear);
    fireEvent.click(clear);
    await waitFor(() => expect(items().length).toBe(0));
    expect(base.requests.filter(({ method, path }) => method === "POST" && path.endsWith("/dismiss")).length).toBe(1);
  });

});

describe("clearing all", () => {
  it("clears every request whatever the filter, says all caught up, and disables Clear all", async () => {
    const { base, board } = await panelOver(TWO_DONE_ONE_FAILED());
    fireEvent.click(inPanel().getByRole("button", { name: /^Failed/ }));
    expect(items().length).toBe(1);
    fireEvent.click(inPanel().getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(items().length).toBe(0));
    expect(textOf(panel().querySelector(".notifications-empty-title"))).toBe("You are all caught up");
    expect((inPanel().getByRole("button", { name: "Clear all" }) as HTMLButtonElement).disabled).toBe(true);
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 0");
    expect(base.requests.filter(({ method, path }) => method === "POST" && path === "/c/here/api/writer/dismiss-finished").length).toBe(1);
    expect(board.view.runs).toEqual([]);
  });

  it("all leaves a request still under way: its card is still on the Tickets page", async () => {
    const { board } = await pageOver([finished(), writerRun({ id: "w2" })], (view) => ({ post: keeping(view) }));
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1"));
    openPanel();
    fireEvent.click(inPanel().getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 0"));
    expect(board.view.runs.map((run) => run.id)).toEqual(["w2"]);
    expect(strips().map((strip) => textOf(strip.querySelector(".run-label")))).toEqual(["Writing"]);
  });

  it("all clears only the requests the panel lists: one that finished after the page last read stays, and its notification is still to come", async () => {
    const { base, board } = await panelOver([finished({ id: "w1" }), writerRun({ id: "w2" })]);
    board.view.runs = board.view.runs.map((run) => (run.id === "w2" ? finished({ id: "w2", minutes: 0 }) : run));
    fireEvent.click(inPanel().getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(base.requests.some(({ path }) => path === "/c/here/api/writer/dismiss-finished")).toBe(true));
    expect(base.requests.find(({ path }) => path === "/c/here/api/writer/dismiss-finished")?.body).toEqual({ ids: ["w1"] });
    await readAgain(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1"));
    expect(board.view.runs.map((run) => run.id)).toEqual(["w2"]);
  });

  it("hides the sentence of a refused clear when asked, and clears it with the next one that works", async () => {
    let refuse = true;
    await panelOver([finished(), failedRun({ id: "w2" })], (view) => ({ post: (path, body) => (refuse ? { status: 409, error: "the board is busy" } : keeping(view)?.(path, body)) }));
    fireEvent.click(inPanel().getByRole("button", { name: "Clear all" }));
    await inPanel().findByRole("alert");
    fireEvent.click(inPanel().getByRole("button", { name: "Hide message" }));
    expect(inPanel().queryByRole("alert")).toBeNull();
    fireEvent.click(inPanel().getByRole("button", { name: "Clear all" }));
    await inPanel().findByRole("alert");
    refuse = false;
    fireEvent.click(inPanel().getByRole("button", { name: "Clear notification: done, 2 min ago" }));
    await waitFor(() => expect(inPanel().queryByRole("alert")).toBeNull());
  });

  it("waits on an item's Clear button while its dismiss is out", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { base } = await panelOver([finished()], (view) => ({ post: keeping(view) }), "tickets", (base) => Object.assign(((input: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" ? held.then(() => base(input, init)) : base(input, init))) as Fetch, base));
    const clear = inPanel().getByRole("button", { name: "Clear notification: done, 2 min ago" }) as HTMLButtonElement;
    fireEvent.click(clear);
    await waitFor(() => expect(clear.disabled).toBe(true));
    release();
    await waitFor(() => expect(items().length).toBe(0));
    expect(base.requests.filter(({ method }) => method === "POST").length).toBe(1);
  });

  it("all is disabled with nothing listed", async () => {
    await pageIn("tickets", []);
    openPanel();
    expect((inPanel().getByRole("button", { name: "Clear all" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's sentence when it refuses, and keeps the item", async () => {
    await panelOver([finished()], () => ({ post: () => ({ status: 409, error: "the board is busy" }) }));
    fireEvent.click(inPanel().getByRole("button", { name: "Clear all" }));
    expect(textOf(await inPanel().findByRole("alert"))).toContain("the board is busy");
    expect(items().length).toBe(1);
  });
});

describe("the filters", () => {
  it("count and filter: All 3, Succeeded 2, Failed 1, each showing only its own items", async () => {
    await panelOver(TWO_DONE_ONE_FAILED());
    const group = inPanel().getByRole("group", { name: "Filter notifications" });
    expect([...group.querySelectorAll("button")].map((button) => textOf(button).replace(/\s+/g, " ").trim())).toEqual(["All 3", "Succeeded 2", "Failed 1"]);
    const labels = () => items().map((item) => textOf(item.querySelector(".notification-label")));
    fireEvent.click(within(group).getByRole("button", { name: /^Succeeded/ }));
    expect(labels()).toEqual(["Done", "Done"]);
    expect(within(group).getByRole("button", { name: /^Succeeded/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: /^Failed/ }));
    expect(labels()).toEqual(["Failed"]);
    fireEvent.click(within(group).getByRole("button", { name: /^All/ }));
    expect(labels()).toEqual(["Done", "Done", "Failed"]);
  });

  it("say what is missing when a filter has nothing in it", async () => {
    await panelOver([finished()]);
    fireEvent.click(inPanel().getByRole("button", { name: /^Failed/ }));
    expect(textOf(panel().querySelector(".notifications-empty-title"))).toBe("No failed notifications");
    expect(textOf(panel().querySelector(".notifications-empty-note"))).toBe("Nothing has failed since these were last cleared.");
    fireEvent.click(inPanel().getByRole("button", { name: /^All/ }));
    expect(items().length).toBe(1);
  });

  it("say that nothing succeeded when only failures are listed", async () => {
    await panelOver([failedRun()]);
    fireEvent.click(inPanel().getByRole("button", { name: /^Succeeded/ }));
    expect(textOf(panel().querySelector(".notifications-empty-title"))).toBe("No succeeded notifications");
  });
});

describe("a request finishing", () => {
  it("opens the panel with that item at the top, marked New, without taking the focus from the ticket search", async () => {
    const { board } = await pageIn("tickets", [finished({ id: "old", minutes: 30, request: "Older" }), writerRun({ id: "w2", request: REQUEST })]);
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1"));
    const search = screen.getByRole("textbox", { name: "Search tickets" });
    search.focus();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    board.view.runs = board.view.runs.map((run) => (run.id === "w2" ? finished({ id: "w2", minutes: 0, request: REQUEST }) : run));
    await readAgain(() => expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy());
    const [top, next] = items() as HTMLElement[];
    expect(textOf(top?.querySelector(".notification-text"))).toBe(REQUEST);
    expect(textOf(top?.querySelector(".notification-chip"))).toBe("New");
    expect(top?.className).toContain("notification-new");
    expect(next?.querySelector(".notification-chip")).toBeNull();
    expect(document.activeElement).toBe(search);
    expect(bell().getAttribute("aria-expanded")).toBe("true");
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 2");
  });

  it("while the panel is open on All adds a Failed item at the top, marked New, and changes nothing else", async () => {
    const { board } = await panelOver([finished({ id: "old", minutes: 30 }), writerRun({ id: "w2" })]);
    expect(panel()).toBeTruthy();
    board.view.runs = board.view.runs.map((run) => (run.id === "w2" ? failedRun({ id: "w2", minutes: 0 }) : run));
    await readAgain(() => expect(items().length).toBe(2));
    expect(items().map((item) => textOf(item.querySelector(".notification-label")))).toEqual(["Failed", "Done"]);
    expect(textOf(items()[0]?.querySelector(".notification-chip"))).toBe("New");
    expect(within(inPanel().getByRole("group", { name: "Filter notifications" })).getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not reopen a panel the person closed when another request finishes later, but a new one opens it again", async () => {
    const { board } = await pageIn("tickets", [writerRun({ id: "w1" }), writerRun({ id: "w2", status: "writing" })]);
    board.view.runs = board.view.runs.map((run) => (run.id === "w1" ? finished({ id: "w1", minutes: 0 }) : run));
    await readAgain(() => expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy());
    openPanel();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    await readAgain(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1"));
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    board.view.runs = board.view.runs.map((run) => (run.id === "w2" ? failedRun({ id: "w2", minutes: 0 }) : run));
    await readAgain(() => expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy());
  });

  it("marks nothing New after a reload: a request first seen finished is listed without the chip", async () => {
    await pageIn("tickets", [finished({ minutes: 0 })]);
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1"));
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    openPanel();
    expect(inPanel().queryByText("New")).toBeNull();
    expect(items()[0]?.className).not.toContain("notification-new");
  });

  it("takes in the request just accepted, so one that finishes before the page reads it unfinished is still new", async () => {
    const { board } = await pageIn("tickets", [writerRun({ id: "w1", phase: "queued", status: "queued" })]);
    board.view.runs = [finished({ id: "w1", minutes: 0 })];
    await readAgain(() => expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy());
    expect(textOf(items()[0]?.querySelector(".notification-chip"))).toBe("New");
  });
});

describe("the keyboard", () => {
  it("closes the panel on Escape and puts the focus on the bell, whether it is pressed on the bell or in the panel", async () => {
    await panelOver([finished()]);
    inPanel().getByRole("button", { name: "Clear all" }).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(document.activeElement).toBe(bell());
    openPanel();
    bell().focus();
    fireEvent.keyDown(bell(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  it("closes a panel that opened by itself on Escape from a link outside it, and puts the focus on the bell", async () => {
    await panelOver([finished()]);
    const link = screen.getAllByRole("link")[0] as HTMLElement;
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  it("leaves another control's Escape to it: the panel stays open and the focus where it was", async () => {
    await panelOver([finished()]);
    const search = screen.getByRole("textbox", { name: "Search tickets" });
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(panel()).toBeTruthy();
    expect(document.activeElement).toBe(search);
  });

  it("names every button in the panel", async () => {
    await panelOver([finished(), failedRun({ id: "w2" })]);
    const names = inPanel().getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? textOf(button).trim());
    expect(names.length).toBe(6);
    expect(names.every((name) => name !== "")).toBe(true);
  });
});
