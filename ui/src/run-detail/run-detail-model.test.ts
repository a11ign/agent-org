import { runActions } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { RUN_STATUSES } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { queueOf, RUNS_OF, type State } from "../../test/run-detail/run-detail-stand.ts";
import type { RunEntry } from "../runs/runs-model.ts";
import { boardOf, boardOfStatus, calloutOf, drawnBoardOf, headerActionsOf, noPullsText, statusWordOf, propertiesOf, pullRowsOf, readyPullOf, stepsOf, terminalHrefOf, timesOf, type RunBoard } from "./run-detail-model.ts";

const queueFor = (state: State) => queueOf(RUNS_OF[state].runs);
const runFor = (state: State): RunEntry => {
  const entry = queueFor(state).entries.find((candidate) => candidate.ticket.key === RUNS_OF[state].key);
  if (entry === undefined) throw new Error(`no run for ${state}`);
  return entry;
};

describe("which board a run is drawn as", () => {
  it("maps every status of RUN_STATUSES to a board, so a status added later fails until it is mapped", () => {
    for (const { status } of RUN_STATUSES) {
      expect(boardOfStatus(status, "running"), status).toBeTruthy();
      expect(boardOfStatus(status, "finished"), status).toBeTruthy();
    }
  });

  it.each<[string, RunBoard]>([
    ["working", "running"], ["talking", "running"], ["planning", "running"], ["reviewing", "running"], ["publishing", "publishing"], ["published", "published"], ["ready-to-merge", "ready"],
    ["checked", "done"], ["completed", "done"], ["queued", "queued"], ["blocked", "blocked"], ["awaiting-review", "awaiting"], ["not-merging", "awaiting"], ["failed", "failed"], ["cancelled", "cancelled"],
  ])("draws %s as the %s board", (status, board) => {
    expect(boardOfStatus(status as never, "running")).toBe(board);
    expect(boardOfStatus(status as never, "finished")).toBe(board);
  });

  it("draws Needs you as the Needs board while the run is live and as Handed back once it has finished", () => {
    expect(boardOfStatus("needs-you", "running")).toBe("needs");
    expect(boardOfStatus("needs-you", "starting")).toBe("needs");
    expect(boardOfStatus("needs-you", "finished")).toBe("handback");
  });

  it.each<[State, RunBoard]>([
    ["running", "running"], ["queued", "queued"], ["blocked", "blocked"], ["needs", "needs"], ["handback", "handback"], ["awaiting", "awaiting"], ["ready", "ready"], ["done", "done"], ["failed", "failed"], ["cancelled", "cancelled"],
  ])("gives the stand's %s run the %s board", (state, board) => {
    expect(boardOf(runFor(state), queueFor(state))).toBe(board);
  });
});

describe("the callout of a run whose pull request is approved and not merging (A11-291)", () => {
  const PULL = "https://github.com/a11ign/plugin/pull/10";
  const REASON = "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml";
  const stuck = () => ({ ...runFor("awaiting"), outcome: { kind: "ready-pr", prs: [{ repo: "plugin", url: PULL }] }, pullHeads: { [PULL]: { head: "91cfe96d0a1b", approved: true, review: "approved", red: [], pending: [], unmergedSince: 1, notMerging: REASON } } }) as unknown as RunEntry;

  it("is titled Approved, not merging and says why, on the Awaiting board, which draws no icon", () => {
    const entry = stuck();
    const queue = queueOf([entry as never]);
    expect(boardOf(entry, queue)).toBe("awaiting");
    const callout = calloutOf(entry, queue, "awaiting");
    expect(callout.title).toBe("Approved, not merging");
    expect(callout.paragraphs[0]).toBe(`Approved, not merging: a11ign/plugin #10 at 91cfe96d, ${REASON}`);
    expect(statusWordOf(entry, queue)).toBe("Approved, not merging");
  });

  it("leaves the title of a run that is merely Awaiting review as it was", () => {
    const entry = runFor("awaiting");
    expect(calloutOf(entry, queueFor("awaiting"), "awaiting").title).toBe("Draft pull request. Waiting for you to approve.");
  });
});

describe("the callout of a run parked on a wait (A11-272)", () => {
  const parkedRun = (waitText: string) => ({ ...runFor("running"), working: { reason: "waits", at: Date.now(), waiting: true, waits: [{ kind: "ticket", key: "A11-229", until: "done" }], waitText } }) as unknown as RunEntry;

  it("is titled Waiting, not Working, and says what it waits on and until when", () => {
    const entry = parkedRun("Waiting on ticket A11-229 (In Progress)");
    const queue = queueOf([entry as never]);
    const callout = calloutOf(entry, queue, boardOf(entry, queue));
    expect(callout.title).toBe("Waiting");
    expect(callout.paragraphs[0]).toMatch(/^Waiting on ticket A11-229 \(In Progress\), until \d\d:\d\d$/);
    expect(statusWordOf(entry, queue)).toBe("Waiting");
  });

  it("draws the header with the Queued board's still ring and quiet colour, not the turning spinner, and a run at work keeps the spinner", () => {
    const entry = parkedRun("Waiting on ticket A11-229 (In Progress)");
    const queue = queueOf([entry as never]);
    expect(drawnBoardOf(entry, queue, "running")).toBe("queued");
    expect(drawnBoardOf(runFor("running"), queueFor("running"), "running")).toBe("running");
    expect(drawnBoardOf(runFor("done"), queueFor("done"), "done")).toBe("done");
  });

  it("is still titled Working for a run at work", () => {
    expect(calloutOf(runFor("running"), queueFor("running"), "running").title).toBe("Working");
  });

  it("names the wait cycle a queued ticket is in, as a paragraph of its callout", () => {
    const files = ["lab:middleware/runtime/main.py"];
    const parked = { ...parkedRun("Waiting on ticket A11-229 (In Progress)"), ticket: { key: "A11-231" }, paths: files } as unknown as RunEntry;
    const held = { ...runFor("queued"), ticket: { key: "A11-229" }, paths: files, blockers: undefined } as unknown as RunEntry;
    const queue = queueOf([parked as never, held as never]);
    expect(calloutOf(held, queue, "queued").paragraphs).toContain("in a wait cycle: A11-229 → A11-231 → A11-229");
  });
});

describe("the callout says the backend's own words", () => {
  const calloutFor = (state: State) => calloutOf(runFor(state), queueFor(state), boardOf(runFor(state), queueFor(state)));

  it("says what a running worker is waiting on (workingNote), under the board's title", () => {
    expect(calloutFor("running")).toEqual({ title: "Working", paragraphs: ["Waiting for fleet:patch --apply to finish on a11y-worker-11. The remaining steps start when it does."], help: null });
  });

  it("says what a waiting agent's dialog says (promptNote), then the board's help line", () => {
    expect(calloutFor("needs")).toEqual({ title: "Needs you", paragraphs: ["Waiting on a person: Do you want to overwrite fleet.ts?"], help: "The agent is waiting on a dialog in its session. Talk to it opens that session in herdr." });
  });

  it("says what a run handed back, then the board's other help line", () => {
    expect(calloutFor("handback")).toEqual({ title: "Needs you", paragraphs: ["Two plans disagree about who owns the retry: which one should win?"], help: "Talk to it opens this run's own session in herdr, with everything it knew." });
  });

  it("says what a blocked run waits on (waitNote)", () => {
    expect(calloutFor("blocked")).toEqual({ title: "Blocked", paragraphs: ["Waits on A11-183: both touch fleet.ts"], help: null });
  });

  it("says nothing of a queued run that waits on nothing, rather than the board's example", () => {
    expect(calloutFor("queued")).toEqual({ title: "Queued", paragraphs: [], help: null });
  });

  it("says the reason a run failed", () => {
    expect(calloutFor("failed")).toEqual({ title: "Failed", paragraphs: ["The worker's session ended with an error: out of memory"], help: null });
  });

  it("says what completed a Completed run (completedLine)", () => {
    expect(calloutFor("done").paragraphs).toEqual(["completed: a11ign/lab #149, a11ign/a11ign #5801 merged"]);
  });

  it("says the pool's review line of a Ready to merge run's pull request, with the board's title", () => {
    expect(calloutFor("ready")).toEqual({ title: "Approved. Waiting for you to merge.", paragraphs: ["a11ign/lab #150: approved at 1f6009d"], help: null });
  });

  it("says nothing of a draft awaiting approval or a cancelled run that the backend has no words for", () => {
    expect(calloutFor("awaiting")).toEqual({ title: "Draft pull request. Waiting for you to approve.", paragraphs: [], help: null });
    expect(calloutFor("cancelled")).toEqual({ title: "Cancelled", paragraphs: [], help: null });
  });

  it("adds the question a worker asked as a second paragraph", () => {
    const entry = { ...runFor("handback"), handedBack: "the board stopped answering its review" } as RunEntry;
    expect(calloutOf(entry, queueFor("handback"), "handback").paragraphs).toEqual(["the board stopped answering its review", "Two plans disagree about who owns the retry: which one should win?"]);
  });

  it("adds a declined safety prompt beside what a running worker is doing", () => {
    const entry = { ...runFor("running"), declined: { command: "rm -rf /" } } as RunEntry;
    expect(calloutOf(entry, queueFor("running"), "running").paragraphs).toEqual(["Waiting for fleet:patch --apply to finish on a11y-worker-11. The remaining steps start when it does.", "A safety prompt was declined automatically: rm -rf /"]);
  });

  it("opens the Ready board's first open pull request, and none when it has none or its address is not http", () => {
    expect(readyPullOf(runFor("ready"))).toEqual({ href: "https://github.com/a11ign/lab/pull/150", label: "Open #150 on GitHub" });
    expect(readyPullOf(runFor("running"))).toBeNull();
    const unsafe = { ...runFor("ready"), outcome: { kind: "reviewed", prs: [{ repo: "a11ign/lab", url: "javascript:alert(1)" }] } } as RunEntry;
    expect(readyPullOf(unsafe)).toBeNull();
  });
});

describe("the header", () => {
  it("is the verbs runActions returns, in its order, with the board's words and the backend's titles", () => {
    for (const state of ["running", "queued", "blocked", "needs", "handback", "awaiting", "ready", "done", "failed", "cancelled"] as const) {
      const entry = runFor(state);
      const queue = queueFor(state);
      expect(headerActionsOf(entry, queue).map(({ verb }) => verb), state).toEqual(runActions(entry, queue.publish, queue.entries));
    }
  });

  it("names Stop and Dismiss as the boards do, and colours them", () => {
    const actions = headerActionsOf(runFor("running"), queueFor("running"));
    expect(actions).toEqual([{ verb: "stop", label: "Stop", title: "Stop run", tone: "danger" }]);
    const finished = headerActionsOf(runFor("failed"), queueFor("failed"));
    expect(finished.map(({ label, tone }) => [label, tone])).toEqual([["Retry", "default"], ["Talk to it", "default"], ["Dismiss", "muted"]]);
    expect(finished.at(-1)?.title).toMatch(/^Take this run off the board/);
  });

  it("says Not started and Queued for a run on the queue, and Running or Ran with when it started otherwise", () => {
    expect(timesOf(runFor("queued"), Date.now())).toEqual({ timing: "Not started", started: "Queued 2 min ago" });
    expect(timesOf(runFor("running"), Date.now())).toEqual({ timing: "Running 52m", started: "Started 52 min ago" });
    expect(timesOf(runFor("ready"), Date.now())).toEqual({ timing: "Ran 14m", started: "Started 20 min ago" });
  });

  it("has a terminal link only for a run whose actions offer no talk verb, that holds a pane, on a machine that names a terminal", () => {
    const connection = { name: "personal", kind: "ssh" } as const;
    const live = { ...runFor("running"), workspace: "ws-1", pane: "p-1" } as RunEntry;
    const template = "https://worker.example/{workspace}/{pane}";
    const stop = headerActionsOf(live, queueFor("running"));
    expect(terminalHrefOf(live, stop, template, connection)).toBe(`/c/personal/terminal?link=${encodeURIComponent("https://worker.example/ws-1/p-1")}`);
    expect(terminalHrefOf(live, stop, null, connection)).toBeNull();
    expect(terminalHrefOf(live, stop, template, null)).toBeNull();
    expect(terminalHrefOf({ ...live, workspace: undefined, pane: undefined } as RunEntry, stop, template, connection)).toBeNull();
    expect(terminalHrefOf({ ...live, pane: undefined } as RunEntry, stop, template, connection)).toBeNull();
    const talking = { ...live, talk: true } as RunEntry;
    expect(terminalHrefOf(talking, headerActionsOf(talking, queueFor("running")), template, connection)).toBeNull();
  });
});

describe("the steps", () => {
  const steps = { ...runFor("running"), plannedSteps: [{ n: 1, title: "one" }, { n: 2, title: "two" }, { n: 3, title: "three" }] } as RunEntry;

  it("marks the current step now, the ones before it done and the ones after it not started", () => {
    expect(stepsOf({ ...steps, currentStep: 2 } as RunEntry).map(({ text, mark }) => [text, mark])).toEqual([["one", "done"], ["two", "now"], ["three", "next"]]);
  });

  it("marks every step not started when the worker has named none", () => {
    expect(stepsOf({ ...steps, currentStep: undefined } as RunEntry).map(({ mark }) => mark)).toEqual(["next", "next", "next"]);
  });

  it("marks every step done when the current step is past the last", () => {
    expect(stepsOf({ ...steps, currentStep: 4 } as RunEntry).map(({ mark }) => mark)).toEqual(["done", "done", "done"]);
  });

  it("draws the steps of a finished run, which keeps them, with none spinning: the steps it reached are done and the rest not started", () => {
    expect(stepsOf({ ...steps, phase: "finished", currentStep: 2 } as RunEntry).map(({ text, mark }) => [text, mark])).toEqual([["one", "done"], ["two", "done"], ["three", "next"]]);
    expect(stepsOf({ ...steps, phase: "finished", currentStep: undefined } as RunEntry).map(({ mark }) => mark)).toEqual(["next", "next", "next"]);
  });

  it("draws the steps a finished entry of the queue kept", () => {
    const kept = { ...runFor("done"), plannedSteps: [{ n: 1, title: "one" }, { n: 2, title: "two" }], currentStep: 2 } as RunEntry;
    expect(stepsOf(kept).map(({ text, mark }) => [text, mark])).toEqual([["one", "done"], ["two", "done"]]);
  });

  it("draws none for a run that recorded no steps", () => {
    expect(stepsOf({ ...steps, plannedSteps: undefined } as RunEntry)).toEqual([]);
    expect(stepsOf(runFor("done"))).toEqual([]);
  });
});

describe("the pull requests", () => {
  it("says Approved at the head's first seven letters for an approved pull request", () => {
    expect(pullRowsOf(runFor("ready"))).toEqual([{ url: "https://github.com/a11ign/lab/pull/150", href: "https://github.com/a11ign/lab/pull/150", label: "a11ign/lab #150", detail: "Approved at 1f6009d", state: "Approved", tone: "approved" }]);
  });

  it("says Merged for a merged one and Draft for a draft the run opened", () => {
    expect(pullRowsOf(runFor("done")).map(({ label, state, detail }) => [label, state, detail])).toEqual([["a11ign/lab #149", "Merged", ""], ["a11ign/a11ign #5801", "Merged", ""]]);
    expect(pullRowsOf(runFor("awaiting")).map(({ state, detail }) => [state, detail])).toEqual([["Draft", "Draft"]]);
  });

  it("says Closed for one closed unmerged and Open for any other", () => {
    const run = { ...runFor("done"), pullStates: { "https://github.com/a11ign/lab/pull/149": "closed" } } as RunEntry;
    expect(pullRowsOf(run).map(({ state }) => state)).toEqual(["Closed", "Open"]);
  });

  it("links no pull request whose address is not http or https", () => {
    const run = { ...runFor("done"), outcome: { kind: "ready-pr", prs: [{ repo: "x/y", url: "javascript:alert(1)" }] } } as RunEntry;
    expect(pullRowsOf(run)[0].href).toBe("");
  });

  it("says the worker opens them when its steps finish on the boards of a run still to work, and that it opened none on the rest", () => {
    expect(noPullsText("running")).toBe("None yet. The worker opens them when its steps finish.");
    expect(noPullsText("queued")).toBe("None yet. The worker opens them when its steps finish.");
    expect(noPullsText("blocked")).toBe("None yet. The worker opens them when its steps finish.");
    expect(noPullsText("failed")).toBe("This run opened no pull requests.");
  });
});

describe("the properties", () => {
  it("lists the repositories, model, plan, worker and version of a run at work", () => {
    expect(propertiesOf(runFor("running"), queueFor("running"))).toEqual({ repos: "control, screenreader-fleet", model: "sonnet/high", plan: "Unattended plan", worker: "agents · a11y-worker-11", tokens: null, version: "On v0.286.0 (instance v0.286.1)" });
  });

  it("names the version when the release differs, and not at all for a finished run that holds no workspace", () => {
    const run = { ...runFor("running"), toolVersion: "v0.280.0" } as RunEntry;
    expect(propertiesOf(run, queueFor("running")).version).toBe("On v0.280 (instance v0.286)");
    expect(propertiesOf({ ...run, phase: "finished", workspace: undefined } as RunEntry, queueFor("running")).version).toBeNull();
    expect(propertiesOf({ ...run, phase: "finished" } as RunEntry, queueFor("running")).version).toBe("On v0.280 (instance v0.286)");
  });

  it("gives the tokens, and says Plan first for a queued run that plans before it works", () => {
    expect(propertiesOf(runFor("ready"), queueFor("ready")).tokens).toBe("74.2M in · 189k out");
    const planFirst = { ...runFor("queued"), plan: { model: "opus", effort: "high" }, planned: false } as RunEntry;
    expect(propertiesOf(planFirst, queueFor("queued")).plan).toBe("Plan first");
    expect(propertiesOf({ ...planFirst, plan: undefined } as RunEntry, queueFor("queued")).plan).toBe("—");
  });

  it("names the worker's instance alone when its host is the same word", () => {
    const run = { ...runFor("running"), worker: { instance: "agents", host: "agents" } } as RunEntry;
    expect(propertiesOf(run, queueFor("running")).worker).toBe("agents");
    expect(propertiesOf({ ...run, worker: undefined } as RunEntry, queueFor("running")).worker).toBeNull();
  });
});
