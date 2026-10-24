import { runActions } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { detailStand, queueOf, RUNS_OF, STATES, type State } from "../../test/run-detail/run-detail-stand.ts";
import { callout, headerButtons, pageFor, screen, textOf, within } from "./run-detail-harness.tsx";

/** What each run board draws, the words it shows and the buttons it has. */
const BOARDS: Readonly<Record<Exclude<State, "loading" | "missing">, Readonly<{ status: string; timing: string; title: string; buttons: string[]; icon: string | null; steps: boolean }>>> = {
  running: { status: "In progress", timing: "Running 52m", title: "Working", buttons: ["Stop"], icon: "Running", steps: true },
  queued: { status: "Queued", timing: "Not started", title: "Queued", buttons: ["Remove"], icon: "Queued", steps: false },
  blocked: { status: "Blocked", timing: "Not started", title: "Blocked", buttons: ["Start anyway", "Remove"], icon: "Queued", steps: false },
  needs: { status: "Needs you", timing: "Running 23m", title: "Needs you", buttons: ["Stop"], icon: "Needs you", steps: false },
  handback: { status: "Needs you", timing: "Ran 23m", title: "Needs you", buttons: ["Retry", "Talk to it", "Dismiss"], icon: "Needs you", steps: false },
  awaiting: { status: "Awaiting review", timing: "Ran 11m", title: "Draft pull request. Waiting for you to approve.", buttons: ["Approve", "Talk to it", "Dismiss"], icon: null, steps: false },
  ready: { status: "Ready to merge", timing: "Ran 14m", title: "Approved. Waiting for you to merge.", buttons: ["Respond to review", "Talk to it", "Dismiss"], icon: "Ready to merge", steps: false },
  done: { status: "Completed", timing: "Ran 8 h 44m", title: "Completed", buttons: ["Dismiss"], icon: "Completed", steps: false },
  failed: { status: "Failed", timing: "Ran 6m", title: "Failed", buttons: ["Retry", "Talk to it", "Dismiss"], icon: "Failed", steps: false },
  cancelled: { status: "Cancelled", timing: "Ran 3m", title: "Cancelled", buttons: ["Retry", "Dismiss"], icon: "Cancelled", steps: false },
};

const RUN_STATES = Object.keys(BOARDS) as (keyof typeof BOARDS)[];

describe("the twelve states", () => {
  it("are the boards' twelve", () => {
    expect([...STATES].sort()).toEqual([...RUN_STATES, "loading", "missing"].sort());
  });

  it.each(RUN_STATES)("%s draws the breadcrumb, the header, the callout and the sections of its board", async (state) => {
    const board = BOARDS[state];
    await pageFor(state);
    const { key, runs } = RUNS_OF[state];
    const entry = runs.find((run) => (run.ticket as { key: string }).key === key) as { ticket: { title: string } };

    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByRole("link", { name: "Runs" }).getAttribute("href")).toBe("/next/runs");
    expect(textOf(screen.getByRole("navigation", { name: "Breadcrumb" }))).toBe(`Runs/${key}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(entry.ticket.title);
    const line = textOf(document.querySelector(".run-head-line"));
    expect(line.startsWith(`${board.status}·${board.timing}·`)).toBe(true);
    expect(line).toMatch(/·(Started|Queued) (\d+ h )?\d+ min ago$/);
    expect(callout().getByText(board.title)).toBeTruthy();
    expect(headerButtons()).toEqual(board.buttons);
    expect(screen.queryByRole("img", { name: board.icon ?? "none" }) !== null).toBe(board.icon !== null);
    expect(screen.queryByRole("heading", { name: /What it will do/ }) !== null).toBe(board.steps);
    expect(screen.getByRole("heading", { name: "Pull requests" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Run properties" })).toBeTruthy();
  });

  it.each(RUN_STATES)("%s has exactly the header verbs runActions gives for its run", async (state) => {
    await pageFor(state);
    const queue = queueOf(RUNS_OF[state].runs);
    const entry = queue.entries.find((run) => run.ticket.key === RUNS_OF[state].key);
    if (entry === undefined) throw new Error("no run");
    const labels: Readonly<Record<string, string>> = { stop: "Stop", dismiss: "Dismiss", talk: "Talk to it", remove: "Remove", retry: "Retry", approve: "Approve", respond: "Respond to review", "start-anyway": "Start anyway", close: "Close", "apply-edit": "Apply edit", "discard-edit": "Discard edit" };
    expect(headerButtons()).toEqual(runActions(entry, queue.publish, queue.entries).map((verb) => labels[verb]));
  });

  it("loading is the board's skeleton, with no breadcrumb and no heading", async () => {
    await pageFor("loading");
    const skeleton = screen.getByRole("status", { name: "Loading run" });
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("run gone is the board's panel with Back to Runs, and no breadcrumb", async () => {
    await pageFor("missing");
    expect(screen.getByText("This run is no longer on the board")).toBeTruthy();
    expect(screen.getByText("It was dismissed or removed. The ticket, its branch and its pull requests are left as they were.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Runs" }).getAttribute("href")).toBe("/next/runs");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });
});

describe("the sections", () => {
  it("draws a finished run's steps, with no step running", async () => {
    const finished = { ...RUNS_OF.failed.runs[0], plannedSteps: [{ n: 1, title: "Read the plan" }, { n: 2, title: "Open the pull request" }], currentStep: 1 };
    await pageFor("failed", detailStand("failed", { runs: [finished] }));
    expect(screen.getByRole("heading", { name: /What it will do/ })).toBeTruthy();
    const steps = [...document.querySelectorAll<HTMLElement>(".step")].map((step) => [textOf(step.querySelector(".step-text")), step.querySelector("svg")?.getAttribute("aria-label")]);
    expect(steps).toEqual([["Read the plan", "Done"], ["Open the pull request", "Not started"]]);
    expect(screen.queryByRole("img", { name: "Running now" })).toBeNull();
  });

  it("draws the running board's five steps with the first one now and the rest not started", async () => {
    await pageFor("running");
    const steps = [...document.querySelectorAll<HTMLElement>(".step")].map((step) => [textOf(step.querySelector(".step-text")), step.querySelector("svg")?.getAttribute("aria-label")]);
    expect(steps).toEqual([["fleet:patch --apply", "Running now"], ["Read back CurrentBuild", "Not started"], ["fleet:deploy and fleet:provision", "Not started"], ["Quote fleet:status", "Not started"], ["Open the control pull request", "Not started"]]);
    expect(screen.getByRole("heading", { name: /What it will do/ }).textContent).toBe("What it will do · from the worker's own note");
  });

  it("draws the empty panel for pull requests on the running board, and the list on the Ready board", async () => {
    await pageFor("running");
    expect(screen.getByText("None yet. The worker opens them when its steps finish.")).toBeTruthy();
  });

  it("draws a pull request's label as a link, its detail and its state", async () => {
    await pageFor("ready");
    const row = document.querySelector<HTMLElement>(".pull-row");
    expect(row?.querySelector("a")?.getAttribute("href")).toBe("https://github.com/a11ign/lab/pull/150");
    expect(textOf(row)).toBe("a11ign/lab #150Approved at 1f6009dApproved");
    expect(screen.queryByText("This run opened no pull requests.")).toBeNull();
  });

  it("draws the Ready board's button to the pull request and its sentence", async () => {
    await pageFor("ready");
    const open = callout().getByRole("link", { name: "Open #150 on GitHub" });
    expect(open.getAttribute("href")).toBe("https://github.com/a11ign/lab/pull/150");
    expect(callout().getByText("A person merges. Nothing is published from here.")).toBeTruthy();
    expect(callout().getByText("a11ign/lab #150: approved at 1f6009d")).toBeTruthy();
  });

  it("says a run that opened no pull request opened none", async () => {
    await pageFor("failed");
    expect(screen.getByText("This run opened no pull requests.")).toBeTruthy();
  });

  it("draws the properties of the running board, with its worker and its version", async () => {
    await pageFor("running");
    const list = document.querySelector(".props-list");
    const rows = [...(list?.querySelectorAll("dt") ?? [])].map((term) => [textOf(term), textOf(term.nextElementSibling)]);
    expect(rows).toEqual([["Ticket", "A11-183"], ["Repositories", "control, screenreader-fleet"], ["Model", "sonnet/high"], ["Plan", "Unattended plan"], ["Worker", "agents · a11y-worker-11"], ["Version", "On v0.286.0 (instance v0.286.1)"]]);
    expect(screen.getByRole("link", { name: "A11-183" }).getAttribute("href")).toBe("https://linear.app/a11ign/issue/A11-183");
  });

  it("draws the tokens row only for a run that has tokens", async () => {
    await pageFor("ready");
    const terms = [...document.querySelectorAll(".props-list dt")].map(textOf);
    expect(terms).toEqual(["Ticket", "Repositories", "Model", "Plan", "Tokens"]);
    expect(textOf(document.querySelector(".prop-tokens"))).toBe("74.2M in · 189k out");
  });
});
