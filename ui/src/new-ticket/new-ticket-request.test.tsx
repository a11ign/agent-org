import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Fetch } from "../api/request.ts";
import { STAGES, writerRun, type Run, type WriterBoard } from "./new-ticket-fixtures.ts";
import { dialog, inDialog, openDialog, pageOver, sent, standOn, pageWith, strips, textOf, typeRequest, writeButton } from "./new-ticket-harness.tsx";
import { writerBoard } from "./new-ticket-fixtures.ts";

// The Sending, Refused and Manual boards, and what the dialog does with the request: Quick and Grill, Auto and Manual, the server's refusal, and a request that carries on with the dialog closed.

const REQUEST = "Add a retry button to the unreachable banner";

/** A request the server takes: it queues a run for the body and answers with the runs after it. `listed` is whether `GET /api/writer` already lists it. */
function accepting(listed: boolean) {
  return (view: WriterBoard["view"]) => ({
    post: (path: string, body: unknown) => {
      if (path !== "/api/writer") return { runs: view.runs };
      const asked = body as { request: string; mode: Run["mode"]; placement: Run["placement"] };
      const run = writerRun({ id: `w${view.runs.length + 1}`, request: asked.request, mode: asked.mode, placement: asked.placement, phase: "queued", status: "queued" });
      if (listed) view.runs.push(run);
      return { runs: [...view.runs, ...(listed ? [] : [run])] };
    },
  });
}

/** The server turns the request down with `sentence`. */
const refusing = (sentence: string) => () => ({ post: () => ({ status: 400, error: sentence }) });

/** Holds `POST /api/writer` until `release` is called, so the request can be looked at while it is out. */
function held() {
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const wrap = (base: ReturnType<typeof import("../../test/fixtures.ts").standFetch>): Fetch => Object.assign(((input: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" && String(input).endsWith("/api/writer") ? gate.then(() => base(input, init)) : base(input, init))) as Fetch, base);
  return { wrap, release };
}

async function overHeld(more: Parameters<typeof writerBoard>[1]) {
  const board = writerBoard([], more);
  const gate = held();
  const page = await pageWith(standOn(board), { wrap: gate.wrap });
  return { ...page, board, release: gate.release };
}

const click = (name: string | RegExp) => fireEvent.click(inDialog().getByRole("button", { name }));

/** The blank tab a Grill opens in the click: a stand-in window, and the spy that hands it out. */
function blankTab() {
  const tab = { closed: false, close: rstest.fn(), location: { href: "" } };
  return { tab, open: rstest.spyOn(window, "open").mockReturnValue(tab as never) };
}

type SendOptions = Readonly<{ text?: string; mode?: "quick" | "grill"; manual?: Readonly<Record<string, string>> }>;

/** Opens the dialog, writes the request, chooses Grill and Manual placement's fields when asked (by their labels), and presses Write ticket. */
function sendRequest({ text = REQUEST, mode = "quick", manual }: SendOptions = {}): void {
  openDialog();
  typeRequest(text);
  if (mode === "grill") fireEvent.click(inDialog().getByRole("radio", { name: /^Grill/ }));
  if (manual !== undefined) {
    fireEvent.click(inDialog().getByRole("radio", { name: "Manual" }));
    for (const [label, value] of Object.entries(manual)) fireEvent.change(inDialog().getByLabelText(new RegExp(`^${label}`)), { target: { value } });
  }
  click("Write ticket");
}

describe("sending a request", () => {
  it("sends a Quick, Auto request as the request, the mode and the placement, and nothing else", async () => {
    const { base } = await pageOver([], accepting(true));
    sendRequest({ text: `  ${REQUEST}  ` });
    await waitFor(() => expect(sent(base)).toEqual([{ request: REQUEST, mode: "quick", placement: "auto" }]));
  });

  it("is accepted: the dialog closes, the new request is in the strip, and the form is empty again", async () => {
    await pageOver([], accepting(false));
    sendRequest({ manual: { Project: "agent-org" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The poll's own read lists no request yet, so the strip is drawn from the answer to the send.
    expect(strips().length).toBe(1);
    expect(textOf(strips()[0]?.querySelector(".run-label") ?? null)).toBe("Queued");
    openDialog();
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).value).toBe("");
    expect(inDialog().getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");
    expect(inDialog().getByRole("radio", { name: /^Quick/ })).toHaveProperty("checked", true);
    fireEvent.click(inDialog().getByRole("radio", { name: "Manual" }));
    expect((inDialog().getByLabelText("Project") as HTMLSelectElement).value).toBe("");
  });

  it("goes back to the page's button: the focus returns to New ticket once the dialog has closed", async () => {
    await pageOver([], accepting(true));
    const opener = screen.getByRole("button", { name: "New ticket" });
    opener.focus();
    sendRequest();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

});

describe("sending a request with a placement", () => {
  it("sends Manual placement's five choices as given, and the writer's brief takes them", async () => {
    const { base, board } = await pageOver([], accepting(true));
    sendRequest({ manual: { Project: "agent-org", Repository: "a11ign", Goal: "Fleet", Priority: "low", Parent: " A11-24 " } });
    await waitFor(() => expect(sent(base).length).toBe(1));
    expect(sent(base)[0]).toEqual({ request: REQUEST, mode: "quick", placement: "manual", project: "agent-org", repo: "a11ign", goal: "Fleet", priority: "low", parent: "A11-24" });
    expect(board.view.runs[0]?.placement).toBe("manual");
  });

  it("sends 'No priority' as a choice of its own, and a field left on Not set not at all", async () => {
    const { base } = await pageOver([], accepting(true));
    sendRequest({ manual: { Priority: "none" } });
    await waitFor(() => expect(sent(base).length).toBe(1));
    expect(sent(base)[0]).toEqual({ request: REQUEST, mode: "quick", placement: "manual", priority: "none" });
  });

  it("sends Manual placement with nothing set as manual alone, and Auto after Manual without the choices that were set", async () => {
    const { base } = await pageOver([], accepting(true));
    sendRequest({ manual: {} });
    await waitFor(() => expect(sent(base).length).toBe(1));
    expect(sent(base)[0]).toEqual({ request: REQUEST, mode: "quick", placement: "manual" });
    openDialog();
    typeRequest(REQUEST);
    fireEvent.click(inDialog().getByRole("radio", { name: "Manual" }));
    fireEvent.change(inDialog().getByLabelText("Project"), { target: { value: "agent-org" } });
    fireEvent.click(inDialog().getByRole("radio", { name: "Auto" }));
    click("Write ticket");
    await waitFor(() => expect(sent(base).length).toBe(2));
    expect(sent(base)[1]).toEqual({ request: REQUEST, mode: "quick", placement: "auto" });
  });

  it("sends Grill as the mode", async () => {
    const { tab, open } = blankTab();
    const { base } = await pageOver([], accepting(true));
    sendRequest({ mode: "grill" });
    await waitFor(() => expect(sent(base)).toEqual([{ request: REQUEST, mode: "grill", placement: "auto" }]));
    open.mockRestore();
  });
});

describe("Grill's tab", () => {
  it("opens a blank tab in the click, and points it at the run's terminal once the run has one", async () => {
    const { tab, open } = blankTab();
    const { board } = await pageOver([], accepting(true));
    sendRequest({ mode: "grill" });
    expect(open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(board.view.runs.length).toBe(1));
    board.view.runs[0] = { ...board.view.runs[0], phase: "running", status: "writing", workspace: "w1", pane: "p1" } as Run;
    await waitFor(() => expect(tab.location.href).toBe(`/c/here/terminal?link=${encodeURIComponent("https://terminal.example/w1/p1")}`), { timeout: 4000 });
    expect(tab.close).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("closes the tab when the server refuses the request", async () => {
    const { tab, open } = blankTab();
    await pageOver([], refusing("grill needs tickets.terminal"));
    sendRequest({ mode: "grill" });
    await within(dialog()).findByRole("alert");
    expect(tab.close).toHaveBeenCalled();
    open.mockRestore();
  });

  it("opens no tab for Quick", async () => {
    const open = rstest.spyOn(window, "open");
    const { base } = await pageOver([], accepting(true));
    sendRequest();
    await waitFor(() => expect(sent(base).length).toBe(1));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

describe("a request the server refuses", () => {
  const SENTENCE = "3 new-ticket requests are unfinished already: finish or stop one before you add another";

  it("says 'Not sent.' with the server's sentence, a full stop where it lacks one, and that the request is still there", async () => {
    await pageOver([], refusing(SENTENCE));
    sendRequest({ manual: { Project: "agent-org" } });
    const alert = await within(dialog()).findByRole("alert");
    expect(textOf(alert)).toBe(`Not sent. ${SENTENCE}. Your request is still here.`);
    expect(dialog()).toBeTruthy();
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).value).toBe(REQUEST);
    expect((inDialog().getByLabelText("Project") as HTMLSelectElement).value).toBe("agent-org");
    expect(inDialog().getByRole("radio", { name: "Manual" }).getAttribute("aria-checked")).toBe("true");
    expect(writeButton().disabled).toBe(false);
    expect(textOf(writeButton())).toBe("Write ticket");
  });

  it("does not double a full stop the server's sentence has", async () => {
    await pageOver([], refusing("no ticket A11-999."));
    sendRequest();
    expect(textOf(await within(dialog()).findByRole("alert"))).toBe("Not sent. no ticket A11-999. Your request is still here.");
  });

  it("sends the same request again from the box, and an accepted one clears it", async () => {
    let refuse = true;
    await pageOver([], (view) => ({ post: (path: string) => (refuse ? { status: 400, error: "tracker is down" } : { runs: view.runs, path }) }));
    sendRequest();
    await within(dialog()).findByRole("alert");
    refuse = false;
    click("Write ticket");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("the request goes on with the dialog closed", () => {
  it("is Sending… while the request is out, with the button busy and disabled", async () => {
    const { release, base } = await overHeld(accepting(true));
    sendRequest();
    expect(textOf(writeButton())).toBe("Sending…");
    expect(writeButton().disabled).toBe(true);
    expect(writeButton().getAttribute("aria-busy")).toBe("true");
    fireEvent.submit(dialog());
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(base).length).toBe(1);
  });

  it("is still Sending… when the dialog is opened again", async () => {
    const { release, base } = await overHeld(accepting(true));
    sendRequest();
    click("Close");
    expect(screen.queryByRole("dialog")).toBeNull();
    openDialog();
    expect(textOf(writeButton())).toBe("Sending…");
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).value).toBe(REQUEST);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(base).length).toBe(1);
  });

  it("shows the refusal, with the request kept, when the dialog is opened after the server refused it", async () => {
    const { release } = await overHeld(refusing("tracker is down"));
    sendRequest();
    click("Close");
    release();
    await waitFor(() => expect(strips().length).toBe(0));
    await Promise.resolve();
    openDialog();
    expect(textOf(await inDialog().findByRole("alert"))).toBe("Not sent. tracker is down. Your request is still here.");
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).value).toBe(REQUEST);
  });

  it("shows a fresh form, and the request in the strip, when it was accepted while the dialog was closed", async () => {
    const { release } = await overHeld(accepting(false));
    sendRequest();
    click("Close");
    release();
    await screen.findByRole("region", { name: "New ticket request" });
    openDialog();
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).value).toBe("");
    expect(textOf(writeButton())).toBe("Write ticket");
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });
});

describe("the strip's buttons and failures", () => {
  it("Stop and Dismiss post to the request and read the requests again", async () => {
    const { base, board } = await pageOver([STAGES.writing, { ...STAGES.done, id: "w2" }], (view) => ({
      post: (path: string) => {
        if (path.endsWith("/dismiss")) view.runs.splice(1, 1);
        return { runs: view.runs };
      },
    }));
    const [writing, done] = strips() as HTMLElement[];
    fireEvent.click(within(writing as HTMLElement).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(base.requests.some(({ method, path }) => method === "POST" && path === "/c/here/api/writer/w1/stop")).toBe(true));
    fireEvent.click(within(done as HTMLElement).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(strips().length).toBe(1));
    expect(base.requests.some(({ method, path }) => method === "POST" && path === "/c/here/api/writer/w2/dismiss")).toBe(true);
    expect(board.view.runs.length).toBe(1);
  });

  it("shows the server's sentence when it refuses a Stop, keeps the card, and Dismiss hides the sentence", async () => {
    await pageOver([STAGES.writing], { post: () => ({ status: 409, error: "the run already ended" }) });
    fireEvent.click(within(strips()[0] as HTMLElement).getByRole("button", { name: "Stop" }));
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("the run already ended");
    expect(strips().length).toBe(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the sentence of a read that failed above the last requests, and Retry reads them again", async () => {
    const board = writerBoard([STAGES.writing]);
    let failing = false;
    Object.defineProperty(board.instance, "writer", { get: () => (failing ? undefined : board.view) });
    const { base } = await pageWith(standOn(board));
    await screen.findByRole("region", { name: "New ticket request" });
    failing = true;
    window.dispatchEvent(new Event("focus"));
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("no route /c/here/api/writer");
    expect(strips().length).toBe(1);
    failing = false;
    const before = base.paths.filter((path) => path.endsWith("/api/writer")).length;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(base.paths.filter((path) => path.endsWith("/api/writer")).length).toBeGreaterThan(before);
  });

  it("reads the tickets again when a request lists a ticket it did not, and not for the first read", async () => {
    const { base, board } = await pageOver([STAGES.writing]);
    const reads = () => base.paths.filter((path) => path === "/c/here/api/tickets").length;
    const before = reads();
    board.view.runs[0] = { ...STAGES.writing, tickets: [{ key: "A11-150", url: null, inPick: null }] } as Run;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("reads the tickets again when a row's Grill finishes", async () => {
    const grill = writerRun({ request: "Grill A11-2", mode: "grill", ticket: "A11-2", workspace: "w1", pane: "p1" } as never);
    const { base, board } = await pageOver([grill]);
    const reads = () => base.paths.filter((path) => path === "/c/here/api/tickets").length;
    const before = reads();
    board.view.runs[0] = { ...grill, phase: "finished", status: "done" } as Run;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});

describe("what the person does while a request is out, and after a Dismiss", () => {
  it("keeps what was typed after the request went out, when it is accepted", async () => {
    const { release } = await overHeld(accepting(true));
    sendRequest();
    typeRequest("The next request, begun while the first was out");
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    openDialog();
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).value).toBe("The next request, begun while the first was out");
  });

  it("takes a dismissed request off the strip at once, even while the poll still lists it, and posts the Dismiss once", async () => {
    const { base } = await pageOver([STAGES.done], { post: () => ({ runs: [] }) });
    const dismiss = within(strips()[0] as HTMLElement).getByRole("button", { name: "Dismiss" });
    fireEvent.click(dismiss);
    fireEvent.click(dismiss);
    await waitFor(() => expect(strips().length).toBe(0));
    expect(base.requests.filter(({ method, path }) => method === "POST" && path.endsWith("/dismiss")).length).toBe(1);
  });

  it("shows a read failure again after a read has answered, though the same sentence was dismissed before", async () => {
    const board = writerBoard([STAGES.writing]);
    let failing = true;
    Object.defineProperty(board.instance, "writer", { get: () => (failing ? undefined : board.view) });
    await pageWith(standOn(board));
    const first = await screen.findByRole("alert");
    fireEvent.click(within(first).getByRole("button", { name: "Dismiss" }));
    failing = false;
    window.dispatchEvent(new Event("focus"));
    await screen.findAllByRole("region", { name: "New ticket request" });
    failing = true;
    window.dispatchEvent(new Event("focus"));
    expect(textOf(await screen.findByRole("alert"))).toContain("no route /c/here/api/writer");
  });
});
