import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { QueueView } from "../api/types.ts";
import type { Fetch } from "../api/request.ts";
import { writerRun, writingConfig } from "./new-ticket-fixtures.ts";
import { inDialog, openDialog, pageOver, sent, standOn, pageWith, strips, textOf, typeRequest } from "./new-ticket-harness.tsx";
import { writerBoard } from "./new-ticket-fixtures.ts";

// Queue after writing (A11-420): the "After writing" row, the Queue pill and "Write and queue" in the dialog, and the run card of a request that will queue its tickets.

const QUEUE_DEFAULTS = { model: "sonnet", effort: "high", planModel: "opus", planEffort: "low", writerModel: "", writerEffort: "" };
const afterWriting = () => inDialog().getByRole("radiogroup", { name: "After writing" });
const choice = (name: "Keep in backlog" | "Queue them") => within(afterWriting()).getByRole("radio", { name }) as HTMLButtonElement;
const submit = () => inDialog().getByRole("button", { name: /^(Write ticket|Write and queue|Sending…)$/ }) as HTMLButtonElement;
const queuePill = () => inDialog().queryByRole("link", { name: /^Queue: / });
const explanation = () => textOf(afterWriting().closest(".nt-placement")?.querySelector(".nt-auto-text") ?? null);

/** The page over a board with the given config and queue, its dialog open. */
async function dialogOver(config = writingConfig({ choice: QUEUE_DEFAULTS }), queue: Partial<QueueView> = {}) {
  const page = await pageOver([], { queue: { entries: [], paused: false, ...queue } as unknown as QueueView }, config);
  openDialog();
  return page;
}

describe("After writing", () => {
  it.each(["quick", "grill"] as const)("sits below Placement with Placement's control, and Keep in backlog is chosen when the dialog opens in %s", async (mode) => {
    await dialogOver();
    if (mode === "grill") fireEvent.click(inDialog().getByRole("radio", { name: /Grill/ }));
    const toggle = afterWriting();
    const placement = inDialog().getByRole("radiogroup", { name: "Placement" });
    expect(placement.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.className).toBe(`${placement.className} nt-after-toggle`);
    expect(within(toggle).getAllByRole("radio").map((radio) => [textOf(radio), radio.getAttribute("aria-checked")])).toEqual([["Keep in backlog", "true"], ["Queue them", "false"]]);
    expect(explanation()).toBe("The tickets wait in the backlog until you queue them.");
    expect(queuePill()).toBeNull();
    expect(textOf(submit())).toBe("Write ticket");
  });

  it("with Queue them and saved defaults of sonnet and high on a board that plans: the explanation, a Queue pill beside the Writer's linking to Settings, and Write and queue", async () => {
    await dialogOver();
    fireEvent.click(choice("Queue them"));
    expect(choice("Queue them").getAttribute("aria-checked")).toBe("true");
    expect(explanation()).toBe("Each ticket the writer files is added to the queue once the writer has finished. They run on the queue defaults, shown below.");
    const pill = queuePill() as HTMLAnchorElement;
    expect(textOf(pill)).toBe("Queuesonnet · high · plan first");
    expect(textOf(pill.querySelector(".nt-pill-choice"))).toBe("sonnet · high · plan first");
    expect(pill.getAttribute("aria-label")).toBe("Queue: sonnet, high effort, plan first. Change in Settings");
    expect(pill.getAttribute("href")).toBe(inDialog().getByRole("link", { name: /^Ticket writer/ }).getAttribute("href"));
    expect(pill.previousElementSibling).toBe(inDialog().getByRole("link", { name: /^Ticket writer/ }));
    expect(textOf(submit())).toBe("Write and queue");
  });

  it("on a board with no planner, the Queue pill names the model and effort with no plan first", async () => {
    await dialogOver(writingConfig({ choice: QUEUE_DEFAULTS, planner: false }));
    fireEvent.click(choice("Queue them"));
    expect(textOf(queuePill()?.querySelector(".nt-pill-choice") ?? null)).toBe("sonnet · high");
    expect(queuePill()?.getAttribute("aria-label")).toBe("Queue: sonnet, high effort. Change in Settings");
  });

  it("while the queue is paused, says the queued tickets wait there until it is resumed", async () => {
    await dialogOver(undefined, { paused: true });
    fireEvent.click(choice("Queue them"));
    await waitFor(() => expect(explanation()).toBe("Each ticket the writer files is added to the queue once the writer has finished, and waits there until the queue is resumed. They run on the queue defaults, shown below."));
  });

  it("sends after queue and no model, effort or plan, and is disabled while the request is sending", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const board = writerBoard([], { queue: { entries: [], paused: false } as unknown as QueueView, post: () => ({ runs: [] }) }, writingConfig({ choice: QUEUE_DEFAULTS }));
    const wrap = (base: Fetch): Fetch => Object.assign(((input: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" ? gate.then(() => base(input, init)) : base(input, init))) as Fetch, base);
    const { base } = await pageWith(standOn(board), { wrap });
    openDialog();
    typeRequest("Add a retry button");
    fireEvent.click(choice("Queue them"));
    expect([choice("Keep in backlog").disabled, choice("Queue them").disabled]).toEqual([false, false]);
    fireEvent.click(submit());
    await waitFor(() => expect(textOf(submit())).toBe("Sending…"));
    expect([choice("Keep in backlog").disabled, choice("Queue them").disabled]).toEqual([true, true]);
    release();
    await waitFor(() => expect(sent(base)).toEqual([{ request: "Add a retry button", mode: "quick", placement: "auto", after: "queue" }]));
  });

  it("sends no after with Keep in backlog, as before", async () => {
    const board = writerBoard([], { post: () => ({ runs: [] }) });
    const { base } = await pageWith(standOn(board));
    openDialog();
    typeRequest("Add a retry button");
    fireEvent.click(submit());
    await waitFor(() => expect(sent(base)).toEqual([{ request: "Add a retry button", mode: "quick", placement: "auto" }]));
  });
});

describe("the run card of a request that queues its tickets", () => {
  const queueAfter = { model: "sonnet", effort: "high", plan: true };

  it("adds Queues them when done with the stamped model and effort, plan first on a board that plans", async () => {
    await pageOver([writerRun({ queueAfter })]);
    expect(textOf(strips()[0]?.querySelector(".run-by") ?? null)).toBe("Ticket writer · sonnet/high · Quick · Queues them when done (sonnet/high, plan first)");
  });

  it("names no plan first on a board with no planner, and adds nothing for a request that keeps its tickets in the backlog", async () => {
    await pageOver([writerRun({ queueAfter }), writerRun({ id: "w2" })], {}, writingConfig({ planner: false }));
    await waitFor(() => expect(strips().map((strip) => textOf(strip.querySelector(".run-by")))).toEqual(["Ticket writer · sonnet/high · Quick · Queues them when done (sonnet/high)", "Ticket writer · sonnet/high · Quick"]));
    expect(screen.queryAllByText(/Queues them when done/).length).toBe(1);
  });
});
