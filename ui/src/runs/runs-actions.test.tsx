import { runActions } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { boardRuns, completed, queuedRun, queueWith, ready, runsStand, working, type RunFields } from "../../test/runs/runs-stand.ts";
import { ACTION_NAME, TALK_TITLE } from "./run-actions.ts";
import { buttonsOf, fireEvent, pageOn, posts, rowOf, screen, textOf, waitFor, within } from "./runs-harness.tsx";

const MINUTE = 60_000;
const key = (fields: RunFields) => (fields.ticket as { key: string }).key;
const base = { startedAgo: 5 * MINUTE };

const holder = { ...working({ key: "A11-10", title: "holds a path", ...base }), paths: ["agent-org:src/pool.ts"] };
const queued = queuedRun("A11-11", "queued, nothing holds it");
const overlapped = { ...queuedRun("A11-12", "queued behind an overlap"), paths: ["agent-org:src/pool.ts"] };
const talking = { ...working({ key: "A11-13", title: "a talk session", ...base }), talk: true };
const parked = { ...completed({ key: "A11-14", title: "parked", ...base, prs: [] }), trackerState: undefined, workspace: "ws-1", pane: "p1", outcome: { kind: "needs-human", reason: "which one?" } };
const awaiting = { ...ready({ key: "A11-15", title: "a draft awaiting approval", ...base }), outcome: { kind: "draft-pr", prs: [{ repo: "a11ign/lab", url: "https://github.com/a11ign/lab/pull/151" }] }, pullHeads: undefined };
const proposed = { ...completed({ key: "A11-16", title: "proposes an edit", ...base, prs: [] }), outcome: { kind: "checked", reason: "r", edit: { why: "the title is wrong" } }, trackerState: undefined };
const finished = completed({ key: "A11-17", title: "finished", ...base });

const RUNS: readonly RunFields[] = [holder, queued, overlapped, talking, parked, awaiting, proposed, finished];
const stand = (post?: () => unknown) => runsStand({ runs: RUNS, ...(post === undefined ? {} : { post }) });

describe("a row's buttons", () => {
  it("are exactly the verbs runActions returns for the run, in its order", async () => {
    await pageOn(stand());
    const queue = queueWith(RUNS);
    for (const run of RUNS) {
      const expected = runActions(run as never, undefined, queue.entries).map((verb) => ACTION_NAME[verb]);
      expect(buttonsOf(key(run))).toEqual(expected);
    }
  });

  it("are, for each kind of run, the verbs the board's rules give", async () => {
    await pageOn(stand());
    expect(buttonsOf("A11-10")).toEqual(["Stop run"]);
    expect(buttonsOf("A11-11")).toEqual(["Remove"]);
    expect(buttonsOf("A11-12")).toEqual(["Start anyway", "Remove"]);
    expect(buttonsOf("A11-13")).toEqual(["Talk to it", "Stop run"]);
    expect(buttonsOf("A11-14")).toEqual(["Close", "Dismiss from list"]);
    expect(buttonsOf("A11-15")).toEqual(["Approve", "Talk to it", "Dismiss from list"]);
    expect(buttonsOf("A11-16")).toEqual(["Apply edit", "Discard edit", "Dismiss from list"]);
    expect(buttonsOf("A11-17")).toEqual(["Dismiss from list"]);
  });

  it("never draws Send back for changes or Comment, on a Ready to merge run too", async () => {
    await pageOn();
    expect(screen.queryByRole("button", { name: "Send back for changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(buttonsOf("A11-180")).toEqual(["Respond to review", "Talk to it", "Dismiss from list"]);
  });

  it("have the board's title for Talk to it and today's titles for the rest", async () => {
    await pageOn(stand());
    const title = (run: string, name: string) => within(rowOf(run)).getByRole("button", { name }).getAttribute("title");
    expect(title("A11-13", "Talk to it")).toBe(TALK_TITLE);
    expect(TALK_TITLE).toBe("Talk to it: opens this run's session in herdr");
    expect(title("A11-12", "Start anyway")).toMatch(/^Start this run now, beside the run that holds a path it shares/);
    expect(title("A11-15", "Approve")).toMatch(/^Drafts reviewed and approved/);
    expect(title("A11-16", "Apply edit")).toMatch(/^Write the worker's proposed title and description/);
    expect(title("A11-16", "Discard edit")).toMatch(/^Drop the worker's proposed edit/);
    expect(title("A11-17", "Dismiss from list")).toMatch(/^Take this run off the board/);
    expect(title("A11-17", "Dismiss from list")).not.toContain("proposed edit");
    expect(title("A11-16", "Dismiss from list")).toContain("Its proposed edit to the ticket's text is dropped too");
  });
});

describe("a press", () => {
  it("posts /api/queue/<key>/<verb> and reads the queue again", async () => {
    const { fetchWith } = await pageOn(stand(() => queueWith(RUNS)));
    const reads = fetchWith.paths.filter((path) => path === "/c/personal/api/queue").length;
    fireEvent.click(within(rowOf("A11-17")).getByRole("button", { name: "Dismiss from list" }));
    await waitFor(() => expect(posts(fetchWith, "/api/queue/A11-17/dismiss")).toHaveLength(1));
    await waitFor(() => expect(fetchWith.paths.filter((path) => path === "/c/personal/api/queue").length).toBeGreaterThan(reads));
    fireEvent.click(within(rowOf("A11-12")).getByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(posts(fetchWith, "/api/queue/A11-12/start-anyway")).toHaveLength(1));
    expect(fetchWith.requests.filter(({ method }) => method === "POST").map(({ path }) => path)).toEqual(["/c/personal/api/queue/A11-17/dismiss", "/c/personal/api/queue/A11-12/start-anyway"]);
  });

  it("waits while the row's request is out, and only that row's buttons", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => { answer = resolve; });
    const instance = runsStand({ runs: RUNS });
    const fetchWith = (await import("../../test/fixtures.ts")).standFetch(instance);
    const slow: typeof fetchWith = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") await pending;
      return fetchWith(input, init);
    }, { paths: fetchWith.paths, requests: fetchWith.requests }) as never;
    const { render } = await import("@testing-library/react");
    const { RunsApp } = await import("./RunsApp.tsx");
    render(<RunsApp fetchWith={slow} />);
    await screen.findByText("A11-17", { exact: false });
    fireEvent.click(within(rowOf("A11-17")).getByRole("button", { name: "Dismiss from list" }));
    await waitFor(() => expect((within(rowOf("A11-17")).getByRole("button", { name: "Dismiss from list" }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(rowOf("A11-10")).getByRole("button", { name: "Stop run" }) as HTMLButtonElement).disabled).toBe(false);
    answer(undefined);
    await waitFor(() => expect((within(rowOf("A11-17")).getByRole("button", { name: "Dismiss from list" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows the server's sentence when it refuses", async () => {
    await pageOn(stand(() => ({ status: 409, error: "A11-10 already ended" })));
    fireEvent.click(within(rowOf("A11-10")).getByRole("button", { name: "Stop run" }));
    expect(textOf(await screen.findByRole("alert"))).toContain("A11-10 already ended");
  });
});

describe("Talk to it", () => {
  const withTerminal = (post: () => unknown) => runsStand({ runs: boardRuns(), terminal: "https://worker.example/{workspace}/{pane}", post });

  it("posts talk, and with no terminal named opens no tab", async () => {
    const open = rstest.spyOn(window, "open");
    const { fetchWith } = await pageOn(stand(() => queueWith(RUNS)));
    fireEvent.click(within(rowOf("A11-13")).getByRole("button", { name: "Talk to it" }));
    await waitFor(() => expect(posts(fetchWith, "/api/queue/A11-13/talk")).toHaveLength(1));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("opens a blank tab in the click when the machine names a terminal, and closes it when the post is refused", async () => {
    const tab = { closed: false, close: rstest.fn(), location: { href: "about:blank" } };
    const open = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    const run = { ...talking, ticket: { key: "A11-13", title: "a talk session" } };
    await pageOn(runsStand({ runs: [run], terminal: "https://worker.example/{workspace}/{pane}", post: () => ({ status: 409, error: "no session" }) }));
    fireEvent.click(within(rowOf("A11-13")).getByRole("button", { name: "Talk to it" }));
    expect(open).toHaveBeenCalledWith("", "terminal-A11-13");
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(textOf(await screen.findByRole("alert"))).toContain("no session");
    open.mockRestore();
  });

  it("points the tab at the run's terminal once the queue shows one", async () => {
    const tab = { closed: false, close: rstest.fn(), location: { href: "about:blank" } };
    const open = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    const live = { ...talking, workspace: "ws-9", pane: "p-9" };
    await pageOn(runsStand({ runs: [live], terminal: "https://worker.example/{workspace}/{pane}", post: () => queueWith([live]) }));
    fireEvent.click(within(rowOf("A11-13")).getByRole("button", { name: "Talk to it" }));
    await waitFor(() => expect(tab.location.href).toContain("/terminal?link=" + encodeURIComponent("https://worker.example/ws-9/p-9")));
    expect(tab.close).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
