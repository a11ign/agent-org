import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { REQUEST, STAGES, writerRun, writingConfig, type Stage } from "./new-ticket-fixtures.ts";
import { pageOver, strips, textOf } from "./new-ticket-harness.tsx";

// The Request: queued, writing and waiting for you boards: the strip under the Tickets header, one card per request still under way, drawn from `GET /api/writer`. A finished request is a notification (`notifications.test.tsx`).

type UnderWay = Exclude<Stage, "done" | "failed">;
const UNDER_WAY: readonly UnderWay[] = ["queued", "writing", "waiting"];
const LABEL: Readonly<Record<UnderWay, string>> = { queued: "Queued", writing: "Writing", waiting: "Waiting for you" };
const BUTTONS: Readonly<Record<UnderWay, readonly string[]>> = { queued: ["Stop"], writing: ["Open terminal", "Stop"], waiting: ["Open terminal", "Stop"] };

const card = (): HTMLElement => within(screen.getByRole("region", { name: "New ticket request" })).getByText(REQUEST.slice(0, 20), { exact: false }).closest("section") as HTMLElement;

describe("a request in each state", () => {
  it.each(UNDER_WAY)("%s: the board's label, head line, buttons and quoted request", async (stage) => {
    await pageOver([STAGES[stage]]);
    const head = card().querySelector(".run-head") as HTMLElement;
    expect(textOf(head.querySelector(".run-label"))).toBe(LABEL[stage]);
    expect(textOf(head.querySelector(".run-by"))).toBe(`Ticket writer · sonnet/high · ${stage === "waiting" ? "Grill" : "Quick"}`);
    const names = [...head.querySelectorAll("a, button")].map((button) => textOf(button));
    expect(names).toEqual(BUTTONS[stage]);
    expect(textOf(card().querySelector(".run-request"))).toBe(`“${REQUEST}”`);
    expect(card().className).toContain(`run-card-${stage}`);
  });

  it("queued, writing: no note", async () => {
    await pageOver([STAGES.queued, { ...STAGES.writing, id: "w2" }]);
    expect(strips().length).toBe(2);
    for (const strip of strips()) expect(strip.querySelector(".run-note")).toBeNull();
  });

  it("finished requests leave the page: only the queued, writing and waiting cards are on it, and none has a Dismiss button", async () => {
    await pageOver([STAGES.done, { ...STAGES.failed, id: "w2" }, { ...STAGES.queued, id: "w3" }, { ...STAGES.writing, id: "w4" }, { ...STAGES.waiting, id: "w5" }]);
    expect(strips().map((strip) => textOf(strip.querySelector(".run-label")))).toEqual(["Queued", "Writing", "Waiting for you"]);
    expect(strips().map((strip) => [...strip.querySelectorAll("a, button")].map((button) => textOf(button)))).toEqual([["Stop"], ["Open terminal", "Stop"], ["Open terminal", "Stop"]]);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("waiting: the writer's own question in the warning note, and Open terminal pointing at its terminal", async () => {
    await pageOver([STAGES.waiting]);
    expect(textOf(card().querySelector(".run-note"))).toBe("Which repository does the banner live in?");
    const terminal = within(card()).getByRole("link", { name: "Open terminal" });
    expect(terminal.getAttribute("href")).toBe(`/c/here/terminal?link=${encodeURIComponent("https://terminal.example/w1/p1")}`);
    expect(terminal.getAttribute("target")).toBe("_blank");
    expect(terminal.getAttribute("title")).toBe("Opens the writer's session in herdr");
  });
});

describe("a request's note, its terminal and the tickets it filed", () => {
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
