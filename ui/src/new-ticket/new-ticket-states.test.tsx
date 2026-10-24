import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FILED, REQUEST, STAGES, writerRun, writingConfig, type Stage } from "./new-ticket-fixtures.ts";
import { pageOver, strips, textOf } from "./new-ticket-harness.tsx";

// The Request: queued, writing, waiting for you, done and failed boards: the strip under the Tickets header, one card per request, drawn from `GET /api/writer`.

const LABEL: Readonly<Record<Stage, string>> = { queued: "Queued", writing: "Writing", waiting: "Waiting for you", done: "Done", failed: "Failed" };
const BUTTONS: Readonly<Record<Stage, readonly string[]>> = { queued: ["Stop"], writing: ["Open terminal", "Stop"], waiting: ["Open terminal", "Stop"], done: ["Dismiss"], failed: ["Dismiss"] };

const card = (): HTMLElement => within(screen.getByRole("region", { name: "New ticket request" })).getByText(REQUEST.slice(0, 20), { exact: false }).closest("section") as HTMLElement;

describe("a request in each state", () => {
  it.each(Object.keys(STAGES) as Stage[])("%s: the board's label, head line, buttons and quoted request", async (stage) => {
    await pageOver([STAGES[stage]]);
    const head = card().querySelector(".run-head") as HTMLElement;
    expect(textOf(head.querySelector(".run-label"))).toBe(LABEL[stage]);
    expect(textOf(head.querySelector(".run-by"))).toBe(`Ticket writer · sonnet/high · ${stage === "waiting" ? "Grill" : "Quick"}`);
    const names = [...head.querySelectorAll("a, button")].map((button) => textOf(button));
    expect(names).toEqual(BUTTONS[stage]);
    expect(textOf(card().querySelector(".run-request"))).toBe(`“${REQUEST}”`);
    expect(card().className).toContain(`run-card-${stage}`);
  });

  it("queued, writing: no note and no tickets", async () => {
    await pageOver([STAGES.queued, { ...STAGES.writing, id: "w2" }]);
    expect(strips().length).toBe(2);
    for (const strip of strips()) {
      expect(strip.querySelector(".run-note")).toBeNull();
      expect(strip.querySelector(".run-made")).toBeNull();
    }
  });

  it("waiting: the writer's own question in the warning note, and Open terminal pointing at its terminal", async () => {
    await pageOver([STAGES.waiting]);
    expect(textOf(card().querySelector(".run-note"))).toBe("Which repository does the banner live in?");
    expect(card().querySelector(".run-note-failed")).toBeNull();
    const terminal = within(card()).getByRole("link", { name: "Open terminal" });
    expect(terminal.getAttribute("href")).toBe(`/c/here/terminal?link=${encodeURIComponent("https://terminal.example/w1/p1")}`);
    expect(terminal.getAttribute("target")).toBe("_blank");
    expect(terminal.getAttribute("title")).toBe("Opens the writer's session in herdr");
  });

  it("failed: the run's own reason in the danger note", async () => {
    await pageOver([STAGES.failed]);
    expect(textOf(card().querySelector(".run-note-failed"))).toBe("the writer ended its turn without creating a ticket");
  });

  it("done: 'Filed by this request' lists each ticket's key, title and meta, linked to the tracker", async () => {
    await pageOver([writerRun({ phase: "finished", status: "done", tickets: [FILED, { key: "A11-144", url: null, inPick: null }] })]);
    expect(textOf(card().querySelector(".run-made-title"))).toBe("Filed by this request");
    const [filed, unread] = [...card().querySelectorAll(".run-ticket")] as HTMLElement[];
    expect(textOf(filed.querySelector(".run-ticket-key"))).toBe("A11-143");
    expect(textOf(filed.querySelector(".run-ticket-title"))).toBe(FILED.title);
    expect(textOf(filed.querySelector(".run-ticket-meta"))).toBe("Medium · a11ign");
    expect(filed.getAttribute("href")).toBe("https://tracker.example/A11-143");
    expect(filed.getAttribute("target")).toBe("_blank");
    expect(unread?.tagName).toBe("DIV");
    expect(textOf(unread)).toBe("A11-144");
  });

  it("done: a ticket whose address is not an http address is not linked", async () => {
    await pageOver([writerRun({ phase: "finished", status: "done", tickets: [{ ...FILED, url: "javascript:alert(1)" }] })]);
    expect(card().querySelector("a.run-ticket")).toBeNull();
    expect(textOf(card().querySelector(".run-ticket-key"))).toBe("A11-143");
  });

  it("leaves the model out of the head line for a request queued before the choice was stamped on it", async () => {
    await pageOver([writerRun({ model: undefined, effort: undefined } as never)]);
    expect(textOf(card().querySelector(".run-by"))).toBe("Ticket writer · Quick");
  });

  it("shows a row's Grill like any other request", async () => {
    await pageOver([writerRun({ request: "Grill A11-2", mode: "grill", ticket: "A11-2", workspace: "w1", pane: "p1" } as never)]);
    expect(textOf(screen.getByRole("region", { name: "New ticket request" }).querySelector(".run-by"))).toBe("Ticket writer · sonnet/high · Grill");
  });

  it("draws nothing, and polls nothing, where the instance writes no tickets", async () => {
    const { base } = await pageOver([STAGES.done], {}, writingConfig({ writer: false }));
    expect(strips().length).toBe(0);
    expect(base.paths.some((path) => path.endsWith("/api/writer"))).toBe(false);
  });

  it("draws no card while no request is listed", async () => {
    await pageOver([]);
    expect(strips().length).toBe(0);
  });

  it("opens Open terminal on a freshly read link by following it as it is", async () => {
    await pageOver([STAGES.writing]);
    const opened = rstest.spyOn(window, "open");
    const link = within(card()).getByRole("link", { name: "Open terminal" });
    expect(fireEvent.click(link)).toBe(true);
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
  });

  it("opens Open terminal on a link built from runs read longer ago than one poll interval by reading it afresh in a tab opened in the click", async () => {
    const { board } = await pageOver([STAGES.writing]);
    const link = within(card()).getByRole("link", { name: "Open terminal" });
    board.view.runs[0] = { ...STAGES.writing, pane: "p2" } as never;
    const tab = { closed: false, close: rstest.fn(), location: { href: "" } };
    const opened = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    const now = Date.now();
    const clock = rstest.spyOn(Date, "now").mockReturnValue(now + 60_000);
    expect(fireEvent.click(link)).toBe(false);
    expect(opened).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(tab.location.href).toBe(`/c/here/terminal?link=${encodeURIComponent("https://terminal.example/w1/p2")}`));
    clock.mockRestore();
    opened.mockRestore();
  });
});
