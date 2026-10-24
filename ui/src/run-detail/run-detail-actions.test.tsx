import { act, fireEvent, render } from "@testing-library/react";
import { PERSONAL, queueingConfig, standFetch, type InstanceAnswers, type Stand } from "../../test/fixtures.ts";
import { addressOf, detailStand, queueOf, RUNS_OF, TERMINAL, type RunFields, type State } from "../../test/run-detail/run-detail-stand.ts";
import { RunsApp } from "../runs/RunsApp.tsx";
import { headerButtons, pageFor, posts, screen, textOf, waitFor, within } from "./run-detail-harness.tsx";
import { NO_TERMINAL, RUN_ENDED, TAB_BLOCKED } from "./use-talk.ts";

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const blankTab = () => ({ closed: false, close: rstest.fn(), location: { href: "about:blank" } });
const queueReads = (fetchWith: { requests: readonly { method: string; path: string }[] }) => fetchWith.requests.filter(({ method, path }) => method === "GET" && path.endsWith("/api/queue")).length;

describe("a press of a header button", () => {
  it("posts /api/queue/<key>/<verb> and has the shell read the queue again", async () => {
    const stand = detailStand("running", { post: () => queueOf([]) });
    const { fetchWith } = await pageFor("running", stand);
    const before = queueReads(fetchWith);
    press("Stop");
    await waitFor(() => expect(posts(fetchWith, "/api/queue/A11-183/stop")).toHaveLength(1));
    await waitFor(() => expect(queueReads(fetchWith)).toBeGreaterThan(before));
  });

  it("shows the server's sentence in the red banner above the header when it refuses", async () => {
    await pageFor("running", detailStand("running", { post: () => ({ status: 409, error: "A11-183 already ended" }) }));
    press("Stop");
    expect(textOf(await screen.findByRole("alert"))).toContain("A11-183 already ended");
    expect(document.querySelector(".alert-banner")?.nextElementSibling?.getAttribute("aria-label")).toBe("Breadcrumb");
  });

  it("posts Apply edit and Discard edit when the run offers them", async () => {
    const proposing = { ...RUNS_OF.done.runs[0], trackerState: undefined, outcome: { kind: "checked", reason: "r", edit: { why: "the title is wrong" } } } as RunFields;
    const { fetchWith } = await pageFor("done", detailStand("done", { runs: [proposing], post: () => queueOf([proposing]) }));
    expect(headerButtons()).toEqual(["Apply edit", "Discard edit", "Dismiss"]);
    expect(screen.getByRole("button", { name: "Dismiss" }).getAttribute("title")).toMatch(/proposed edit to the ticket's text is dropped too/);
    press("Discard edit");
    await waitFor(() => expect(posts(fetchWith, "/api/queue/A11-127/discard-edit")).toHaveLength(1));
  });

  it("draws Close on a parked run", async () => {
    const parked = { ...RUNS_OF.handback.runs[0], workspace: "ws-1", pane: "p-1" } as RunFields;
    await pageFor("handback", detailStand("handback", { runs: [parked] }));
    expect(headerButtons()).toEqual(["Close", "Dismiss"]);
  });
});

describe("Talk to it", () => {
  const readyRun = RUNS_OF.ready.runs[0];

  it("is one button for a run whose actions offer talk, and no terminal link beside it", async () => {
    const talking = { ...RUNS_OF.running.runs[0], talk: true, workspace: "ws-9", pane: "p-9" } as RunFields;
    await pageFor("running", detailStand("running", { runs: [talking], terminal: TERMINAL }));
    expect(headerButtons()).toEqual(["Talk to it", "Stop"]);
    expect(document.querySelectorAll(".run-buttons a")).toHaveLength(0);
  });

  it("is the terminal link for a parked run too, which keeps its pane but offers no talk verb", async () => {
    const parked = { ...readyRun, workspace: "ws-9", pane: "p-9" } as RunFields;
    await pageFor("ready", detailStand("ready", { runs: [parked], terminal: TERMINAL }));
    expect(headerButtons()).toEqual(["Talk to it", "Close", "Respond to review", "Dismiss"]);
    expect(document.querySelectorAll(".run-buttons a")).toHaveLength(1);
  });

  it("is the terminal link for a running run that holds a pane, opening herdr in a new tab, and the only one", async () => {
    const running = { ...RUNS_OF.running.runs[0], workspace: "ws-9", pane: "p-9" } as RunFields;
    await pageFor("running", detailStand("running", { runs: [running], terminal: TERMINAL }));
    const link = screen.getByRole("link", { name: "Talk to it" });
    expect(link.getAttribute("href")).toBe(`/c/personal/terminal?link=${encodeURIComponent("https://worker.example/ws-9/p-9")}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("title")).toBe("Opens this run's session in herdr");
    expect(headerButtons()).toEqual(["Talk to it", "Stop"]);
  });

  it("is not drawn for a running run on a machine that names no terminal, or with no pane", async () => {
    const running = { ...RUNS_OF.running.runs[0], workspace: "ws-9", pane: "p-9" } as RunFields;
    await pageFor("running", detailStand("running", { runs: [running] }));
    expect(headerButtons()).toEqual(["Stop"]);
  });
});

describe("Talk to it, when herdr does not open", () => {
  const readyRun = RUNS_OF.ready.runs[0];

  it("with no terminal named posts the verb with no tab and says to name tickets.terminal", async () => {
    const open = rstest.spyOn(window, "open");
    const { fetchWith } = await pageFor("ready", detailStand("ready", { post: () => queueOf([readyRun]) }));
    press("Talk to it");
    await waitFor(() => expect(posts(fetchWith, "/api/queue/A11-180/talk")).toHaveLength(1));
    expect(textOf(await screen.findByRole("alert"))).toContain(NO_TERMINAL);
    expect(NO_TERMINAL).toBe("Talk to it needs a terminal: name tickets.terminal in the host file");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("when the browser refuses the tab posts nothing and says to allow pop-ups and press again", async () => {
    const open = rstest.spyOn(window, "open").mockReturnValue(null);
    const { fetchWith } = await pageFor("ready", detailStand("ready", { terminal: TERMINAL, post: () => queueOf([readyRun]) }));
    press("Talk to it");
    expect(open).toHaveBeenCalledWith("", "terminal-A11-180");
    expect(textOf(await screen.findByRole("alert"))).toContain(TAB_BLOCKED);
    expect(TAB_BLOCKED).toBe("The browser blocked the new tab: allow pop-ups for this page, then press Talk to it again");
    expect(posts(fetchWith, "/api/queue/A11-180/talk")).toHaveLength(0);
    open.mockRestore();
  });

  it("when the server refuses the post says its sentence and closes the blank tab", async () => {
    const tab = blankTab();
    const open = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    await pageFor("ready", detailStand("ready", { terminal: TERMINAL, post: () => ({ status: 409, error: "no session to resume" }) }));
    press("Talk to it");
    expect(textOf(await screen.findByRole("alert"))).toContain("no session to resume");
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    open.mockRestore();
  });

  it("when the run ended before it had a pane closes the tab and says herdr did not open", async () => {
    const tab = blankTab();
    const open = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    await pageFor("ready", detailStand("ready", { terminal: TERMINAL, post: () => queueOf([readyRun]) }));
    press("Talk to it");
    expect(textOf(await screen.findByRole("alert"))).toContain(RUN_ENDED);
    expect(RUN_ENDED).toBe("herdr did not open this run's session: the run ended before it had one. Retry queues it again");
    expect(tab.close).toHaveBeenCalled();
    open.mockRestore();
  });

  it("points the tab at the run's terminal once the queue shows a pane, with nothing in the banner", async () => {
    const tab = blankTab();
    const open = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    // The instance holds the run's pane once it has been asked to talk, as the real one does.
    const withPane = { ...readyRun, workspace: "ws-9", pane: "p-9" } as RunFields;
    const asked = { runs: [readyRun] };
    const instance: InstanceAnswers = { config: queueingConfig({ terminal: TERMINAL } as never), get queue() { return queueOf(asked.runs); }, post: () => { asked.runs = [withPane]; return queueOf(asked.runs); } };
    await pageFor("ready", { connections: [PERSONAL], instances: { personal: instance } });
    press("Talk to it");
    await waitFor(() => expect(tab.location.href).toContain(`/terminal?link=${encodeURIComponent("https://worker.example/ws-9/p-9")}`));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

describe("polling", () => {
  /** An instance whose queue the check changes between the shell's reads. */
  function movingInstance(first: readonly RunFields[]) {
    const state = { runs: first };
    const instance: InstanceAnswers = { config: queueingConfig(), get queue() { return queueOf(state.runs); } };
    return { state, stand: { connections: [PERSONAL], instances: { personal: instance } } };
  }
  const advance = (ms: number) => act(async () => { await rstest.advanceTimersByTimeAsync(ms); });
  /** Renders the page under fake time and lets the connections, the config and the queue be read. */
  async function opened(state: State, stand: Stand) {
    history.replaceState(null, "", addressOf(state));
    render(<RunsApp fetchWith={standFetch(stand)} />);
    for (let hop = 0; hop < 6; hop += 1) await advance(0);
  }

  beforeEach(() => {
    rstest.useFakeTimers();
  });
  afterEach(() => {
    rstest.useRealTimers();
  });

  it("follows the run while it works: its step and its state change at the next read", async () => {
    const { state, stand } = movingInstance(RUNS_OF.running.runs);
    await opened("running", stand);
    expect(screen.getByRole("img", { name: "Running now" })).toBeTruthy();
    const failed = { ...RUNS_OF.failed.runs[0], ticket: RUNS_OF.running.runs[0].ticket } as RunFields;
    state.runs = [failed];
    await advance(5_000);
    expect(within(screen.getByRole("region", { name: "Current state" })).getByText("Failed")).toBeTruthy();
    expect(headerButtons()).toEqual(["Retry", "Talk to it", "Dismiss"]);
    expect(screen.queryByRole("heading", { name: /What it will do/ })).toBeNull();
  });

  it("moves the marked step when the worker reports the next one", async () => {
    const { state, stand } = movingInstance(RUNS_OF.running.runs);
    await opened("running", stand);
    state.runs = [{ ...RUNS_OF.running.runs[0], currentStep: 3 }];
    await advance(5_000);
    const marks = [...document.querySelectorAll(".step svg")].map((mark) => mark.getAttribute("aria-label"));
    expect(marks).toEqual(["Done", "Done", "Running now", "Not started", "Not started"]);
  });

  it("shows run gone once the run leaves the queue, whether the queue holds others or none", async () => {
    const { state, stand } = movingInstance(RUNS_OF.running.runs);
    await opened("running", stand);
    state.runs = [RUNS_OF.queued.runs[0]];
    await advance(5_000);
    expect(screen.getByText("This run is no longer on the board")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    state.runs = [];
    await advance(5_000);
    expect(screen.getByText("This run is no longer on the board")).toBeTruthy();
  });
});
