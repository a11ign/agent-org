import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { standFetch, ticket, type InstanceAnswers } from "../../test/fixtures.ts";
import type { QueueView } from "../api/types.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { answers, BACKLOG, bar, openPage, posts, standOf, textOf, tick, rowOf } from "./tickets-harness.tsx";
import { TicketsPage } from "./TicketsPage.tsx";

const queued: QueueView = { entries: [{ ticket: { key: "A11-1" }, phase: "queued" }], paused: false } as unknown as QueueView;
const standWith = (post: InstanceAnswers["post"] = () => queued) => standOf(answers(BACKLOG, { post }));
const cog = () => screen.getByRole("button", { name: "Run options" });

describe("the Run options popover", () => {
  it("opens from the cog, which says it is expanded, with the controls of the Pick footer and nothing else", async () => {
    await openPage(standWith());
    tick("A11-1");
    expect(cog().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(cog());
    expect(cog().getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "Run options" });
    expect(textOf(dialog)).toContain("this batch only");
    expect(within(dialog).getByLabelText(/^Plan first/).closest("label")?.textContent).toBe("Plan first (opus · low)");
    expect((within(dialog).getByLabelText("Model") as HTMLSelectElement).value).toBe("sonnet");
    expect((within(dialog).getByLabelText("Effort") as HTMLSelectElement).value).toBe("high");
    expect(within(dialog).getByRole("link", { name: "Change defaults" }).getAttribute("href")).toBe("/next/settings/models");
    expect(within(dialog).getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(dialog.querySelectorAll("select, input, button, a")).toHaveLength(5);
  });

  it("closes on Escape with the focus back on the cog, and on a click outside", async () => {
    await openPage(standWith());
    tick("A11-1");
    fireEvent.click(cog());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Run options" })).toBeNull();
    expect(document.activeElement).toBe(cog());
    fireEvent.click(cog());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Run options" })).toBeNull();
  });

  it("shows the Custom pill with the model, effort and plan when they differ from the default, and Reset takes it away", async () => {
    await openPage(standWith());
    tick("A11-1");
    expect(screen.queryByText(/^Custom/)).toBeNull();
    fireEvent.click(cog());
    const dialog = screen.getByRole("dialog", { name: "Run options" });
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "opus" } });
    expect(screen.getByText("Custom · Plan first · opus/high")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Effort"), { target: { value: "low" } });
    expect(screen.getByText("Custom · Plan first · opus/low")).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(/^Plan first/));
    expect(screen.getByText("Custom · No plan · opus/low")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(screen.queryByText(/^Custom/)).toBeNull();
    expect((within(dialog).getByLabelText(/^Plan first/) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText("Model") as HTMLSelectElement).value).toBe("sonnet");
  });

  it("offers Plan first only while a selected ticket has no plan of its own", async () => {
    await openPage(standOf(answers([ticket({ key: "A11-1", uploads: ["plan.md"] } as never), ticket({ key: "A11-2" })], { post: () => queued })));
    tick("A11-1");
    fireEvent.click(cog());
    expect(within(screen.getByRole("dialog", { name: "Run options" })).queryByLabelText(/^Plan first/)).toBeNull();
    tick("A11-2");
    expect(within(screen.getByRole("dialog", { name: "Run options" })).getByLabelText(/^Plan first/)).toBeTruthy();
  });

});

describe("queueing from the popover", () => {
  it("queues the keys on the default model and effort, planned first, then clears the selection and reads the queue again", async () => {
    const { fetchWith } = await openPage(standWith());
    tick("A11-1");
    tick("A11-2");
    const before = fetchWith.paths.filter((path) => path === "/c/here/api/queue").length;
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 2 tickets" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull());
    expect(posts(fetchWith, "/api/queue").map(({ body }) => body)).toEqual([{ keys: ["A11-1", "A11-2"], model: "sonnet", effort: "high", plan: true }]);
    await waitFor(() => expect(fetchWith.paths.filter((path) => path === "/c/here/api/queue").length).toBeGreaterThan(before));
  });

  it("queues with the batch's own model and effort, and then the next batch starts from the default again", async () => {
    const { fetchWith } = await openPage(standWith());
    tick("A11-1");
    fireEvent.click(cog());
    const dialog = screen.getByRole("dialog", { name: "Run options" });
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "opus" } });
    fireEvent.change(within(dialog).getByLabelText("Effort"), { target: { value: "low" } });
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    await waitFor(() => expect(posts(fetchWith, "/api/queue")).toHaveLength(1));
    expect(posts(fetchWith, "/api/queue")[0].body).toEqual({ keys: ["A11-1"], model: "opus", effort: "low", plan: true });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull());
    tick("A11-2");
    expect(screen.queryByText(/^Custom/)).toBeNull();
    fireEvent.click(cog());
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("sonnet");
  });

  it("queues without planning first when Plan first is unticked", async () => {
    const { fetchWith } = await openPage(standWith());
    tick("A11-1");
    fireEvent.click(cog());
    fireEvent.click(within(screen.getByRole("dialog", { name: "Run options" })).getByLabelText(/^Plan first/));
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    await waitFor(() => expect(posts(fetchWith, "/api/queue")).toHaveLength(1));
    expect(posts(fetchWith, "/api/queue")[0].body).toEqual({ keys: ["A11-1"], model: "sonnet", effort: "high", plan: false });
  });

  it("sends no plan when no selected ticket needs one", async () => {
    const { fetchWith } = await openPage(standOf(answers([ticket({ key: "A11-1", uploads: ["plan.md"] } as never)], { post: () => queued })));
    tick("A11-1");
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    await waitFor(() => expect(posts(fetchWith, "/api/queue")).toHaveLength(1));
    expect(posts(fetchWith, "/api/queue")[0].body).toMatchObject({ plan: false });
  });

});

describe("a queue the server refuses, and one still out", () => {
  it("shows the server's sentence when it refuses, keeps the selection, and Retry reads the tickets again", async () => {
    const { fetchWith } = await openPage(standWith(() => ({ status: 409, error: "A11-1 is already on the queue" })));
    tick("A11-1");
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("A11-1 is already on the queue");
    expect(textOf(bar())).toContain("1 selected");
    const reads = fetchWith.paths.filter((path) => path === "/c/here/api/tickets").length;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchWith.paths.filter((path) => path === "/c/here/api/tickets").length).toBe(reads + 1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hides the refusal with Dismiss", async () => {
    await openPage(standWith(() => ({ status: 409, error: "nope" })));
    tick("A11-1");
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cannot be pressed again while its request is out", async () => {
    const inner = standFetch(standWith());
    let release: () => void = () => undefined;
    const fetching = ((input: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" ? new Promise<Response>((done) => { release = () => done(new Response(JSON.stringify(queued))); }) : inner(input, init))) as typeof fetch;
    render(<ShellProvider fetchWith={fetching}><ShellFrame page="tickets"><TicketsPage /></ShellFrame></ShellProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Expand Backlog" }));
    tick("A11-1");
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    await waitFor(() => expect((within(bar()).getByRole("button", { name: "Queue 1 ticket" }) as HTMLButtonElement).disabled).toBe(true));
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull());
  });
});

describe("what the page knows right after a Queue", () => {
  it("keeps a ticket the server just queued off the checkboxes while the queue poll's answer is still the old one", async () => {
    await openPage(standWith());
    tick("A11-1");
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull());
    expect(within(rowOf("A11-1")).getByText("On the queue: queued")).toBeTruthy();
    expect((within(rowOf("A11-1")).getByLabelText("Select A11-1") as HTMLInputElement).disabled).toBe(true);
  });

  it("puts the batch back on the default after a Queue, Plan first included, so nothing hidden rides on the next one", async () => {
    await openPage(standWith());
    tick("A11-2");
    fireEvent.click(cog());
    fireEvent.click(within(screen.getByRole("dialog", { name: "Run options" })).getByLabelText(/^Plan first/));
    expect(screen.getByText("Custom · No plan · sonnet/high")).toBeTruthy();
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Queue selected tickets" })).toBeNull());
    tick("A11-3");
    expect(screen.queryByText(/^Custom/)).toBeNull();
  });

  it("puts the batch back on the default when the selection is cleared", async () => {
    await openPage(standWith());
    tick("A11-1");
    fireEvent.click(cog());
    fireEvent.change(within(screen.getByRole("dialog", { name: "Run options" })).getByLabelText("Model"), { target: { value: "opus" } });
    fireEvent.click(within(bar()).getByRole("button", { name: "Clear" }));
    tick("A11-1");
    expect(screen.queryByText(/^Custom/)).toBeNull();
  });
});
