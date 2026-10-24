import { fireEvent, renderHook } from "@testing-library/react";
import type { QueueView } from "../api/types.ts";
import { useQueueReadAt } from "./use-stale-terminal.ts";
import { PERSONAL, queueingConfig, type InstanceAnswers } from "../../test/fixtures.ts";
import { detailStand, queueOf, RUNS_OF, TERMINAL, type RunFields } from "../../test/run-detail/run-detail-stand.ts";
import { pageFor, screen, textOf, waitFor, within } from "./run-detail-harness.tsx";

// What `ui.html` shows of a run that A11-198's callout leaves out (A11-220): what changed in the ticket, what the plan learns from, the proposed edit's text, and every line of the run's note.

const MINUTE = 60_000;
const ticketOf = (key: string) => ({ key, title: `Title of ${key}`, url: `https://linear.app/a11ign/issue/${key}` });

/** A run still on the queue, with `more` to say what it holds. */
const queued = (key: string, more: RunFields = {}): RunFields =>
  ({ ticket: ticketOf(key), phase: "queued", model: "sonnet", effort: "high", repos: ["a11ign"], queuedAt: Date.now() - 2 * MINUTE, ...more });

/** A run that finished, with `more` to say how. */
const finished = (key: string, more: RunFields = {}): RunFields => {
  const startedAt = Date.now() - 20 * MINUTE;
  return { ticket: ticketOf(key), phase: "finished", model: "sonnet", effort: "high", planned: true, repos: ["a11ign"], queuedAt: startedAt - MINUTE, startedAt, finishedAt: startedAt + 14 * MINUTE, ...more };
};

const CHANGE = { at: Date.now(), from: "Keep this line\nThe old line\n", to: "Keep this line\nThe new line\n<b>not markup</b>\n" };
const BLOCKER_PULL = "https://github.com/a11ign/agent-org/pull/3";
const EDIT = { why: "the ticket names a file that moved", base: { title: "Old title", description: "Old description" }, title: "New title" };

/** Run detail for a single run, opened at its address. */
const open = (run: RunFields) => pageFor("queued", detailStand("queued", { runs: [run] }), `/next/runs/${(run.ticket as { key: string }).key}`);

const disclosure = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>("details.disclosure")].find((node) => textOf(node.querySelector("summary")).includes(name));
  if (found === undefined) throw new Error(`no disclosure called ${name}`);
  return found;
};
const learnsLine = (): HTMLElement => document.querySelector(".disclosure-line") as HTMLElement;
const disclosures = (): string[] => [...document.querySelectorAll<HTMLElement>("details.disclosure > summary")].map(textOf);

describe("What changed in the ticket", () => {
  it("is a closed disclosure named for the ticket, with the board's line beside it", async () => {
    await open(queued("A11-80", { ticketChange: CHANGE }));
    const node = disclosure("What changed in A11-80");
    expect(node.hasAttribute("open")).toBe(false);
    expect(textOf(node.querySelector("summary"))).toBe("What changed in A11-80ticket changed since plan, re-planning first");
  });

  it("draws the removed lines struck, the added lines added and the rest plain, one to a line", async () => {
    await open(queued("A11-80", { ticketChange: CHANGE }));
    const body = disclosure("What changed in A11-80").querySelector("pre") as HTMLElement;
    expect([...body.querySelectorAll("del")].map(textOf)).toEqual(["The old line"]);
    expect([...body.querySelectorAll("ins")].map(textOf)).toEqual(["The new line", "<b>not markup</b>"]);
    expect([...body.querySelectorAll(".diff-same")].map(textOf)).toContain("Keep this line");
  });

  it("draws markup in a line as text", async () => {
    await open(queued("A11-80", { ticketChange: CHANGE }));
    const body = disclosure("What changed in A11-80").querySelector("pre") as HTMLElement;
    expect(body.querySelector("b")).toBeNull();
  });

  it("says what a live run was told when the change was sent to its worker", async () => {
    await open({ ...finished("A11-81"), phase: "running", ticketChanges: [CHANGE] });
    expect(textOf(disclosure("What changed in A11-81").querySelector("summary"))).toContain("ticket changed: sent to the worker at ");
  });

  it("is not drawn for a run whose ticket did not change, or that has finished", async () => {
    await open(finished("A11-82", { ticketChange: CHANGE }));
    expect(disclosures().filter((name) => name.startsWith("What changed"))).toEqual([]);
  });
});

describe("what a queued run learns from", () => {
  it("is a line with each blocker's merged pull request linked in a new tab", async () => {
    await open(queued("A11-83", { learned: { [BLOCKER_PULL]: { key: "A11-165", number: 3, file: "findings.md" } } }));
    const link = within(learnsLine()).getByRole("link", { name: "A11-165 (#3 merged)" });
    expect(link.getAttribute("href")).toBe(BLOCKER_PULL);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("lists several, separated by commas", async () => {
    await open(queued("A11-83", { learned: { [BLOCKER_PULL]: { key: "A11-165", number: 3, file: "a" }, "https://github.com/a11ign/agent-org/pull/4": { key: "A11-166", number: 4, file: "b" } } }));
    expect(textOf(learnsLine())).toBe("learns from A11-165 (#3 merged), A11-166 (#4 merged)");
  });

  it("is not drawn for a run that learns from nothing", async () => {
    await open(queued("A11-83"));
    expect(document.querySelector(".disclosure-line")).toBeNull();
  });
});

describe("the proposed edit to the ticket", () => {
  const withEdit = (edit: Record<string, unknown>) => finished("A11-84", { outcome: { kind: "needs-human", reason: "I would change the ticket", edit } });

  it("is a closed disclosure named for why, with the ticket's text now and as it would be", async () => {
    await open(withEdit(EDIT));
    const node = disclosure("Proposed edit to the ticket: the ticket names a file that moved");
    expect(node.hasAttribute("open")).toBe(false);
    const texts = [...node.querySelectorAll("pre")].map(textOf);
    expect(texts).toEqual(["Old title\n\nOld description", "New title\n\nOld description"]);
    expect([...node.querySelectorAll(".disclosure-label")].map(textOf)).toEqual(["Now", "Proposed"]);
  });

  it("takes the current text for a part the edit leaves out", async () => {
    await open(withEdit({ why: "w", base: { title: "T", description: "D" }, description: "D2" }));
    expect([...disclosure("Proposed edit").querySelectorAll("pre")].map(textOf)).toEqual(["T\n\nD", "T\n\nD2"]);
  });

  it("draws an empty now when the edit carries no base", async () => {
    await open(withEdit({ why: "w", title: "T2", description: "D2" }));
    expect([...disclosure("Proposed edit").querySelectorAll("pre")].map(textOf)).toEqual(["\n\n", "T2\n\nD2"]);
  });

  it("is not drawn for a run with no edit", async () => {
    await open(finished("A11-84", { outcome: { kind: "needs-human", reason: "A question" } }));
    expect(disclosures().filter((name) => name.startsWith("Proposed edit"))).toEqual([]);
  });
});

describe("everything this run noted", () => {
  it("holds every line of the Runs row's note, whole, one to a line", async () => {
    await open(queued("A11-85", { sessionNote: "it resumed the session of its planner", ticketChange: CHANGE, learned: { [BLOCKER_PULL]: { key: "A11-165", number: 3, file: "f" } } }));
    const lines = [...disclosure("Everything this run noted").querySelectorAll("li")].map(textOf);
    expect(lines).toContain("it resumed the session of its planner");
    expect(lines).toContain("ticket changed since plan, re-planning first");
    expect(lines).toContain("learns from A11-165 (#3 merged)");
  });

  it("holds a done run's evidence, which the row reaches only by hovering", async () => {
    await open(finished("A11-86", { outcome: { kind: "done", reason: "done", evidence: ["pnpm test: 12 of 12 pass", "the screenshot is attached"] } }));
    expect([...disclosure("Everything this run noted").querySelectorAll("li")].map(textOf)).toEqual(expect.arrayContaining(["pnpm test: 12 of 12 pass", "the screenshot is attached"]));
  });

  it("starts closed, and is a native disclosure whose summary a keyboard reaches", async () => {
    await open(queued("A11-85", { sessionNote: "a note" }));
    const node = disclosure("Everything this run noted");
    expect(node.hasAttribute("open")).toBe(false);
    expect(node.tagName).toBe("DETAILS");
    expect(node.querySelector("summary")?.tagName).toBe("SUMMARY");
  });

  it("is not drawn for a run with no note", async () => {
    await open(queued("A11-87"));
    expect(disclosures()).toEqual([]);
    expect(screen.queryByRole("region", { name: "More about this run" })).toBeNull();
  });
});

describe("the run's terminal link read afresh when its queue is older than one poll", () => {
  const holder = RUNS_OF.running.runs[0];
  const FRESH = `/terminal?link=${encodeURIComponent("https://worker.example/ws-11/p-1")}`;
  const blankTab = () => ({ closed: false, close: rstest.fn(), location: { href: "about:blank" } });
  const link = (): HTMLAnchorElement => screen.getByRole("link", { name: "Talk to it" }) as HTMLAnchorElement;
  /** The page open on the running board, then the clock moved on by `ms`: the queue it drew is that much older. */
  async function aged(ms: number, runs: readonly RunFields[] = [holder]) {
    const instance: InstanceAnswers = { config: queueingConfig({ terminal: TERMINAL } as never), get queue() { return queueOf(runs); } };
    await pageFor("running", { connections: [PERSONAL], instances: { personal: instance } });
    const now = Date.now();
    rstest.spyOn(Date, "now").mockReturnValue(now + ms);
  }
  afterEach(() => { rstest.restoreAllMocks(); });

  it("follows the link as it is while the queue is fresh, opening no tab", async () => {
    await aged(1000);
    const open = rstest.spyOn(window, "open");
    expect(fireEvent.click(link())).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the tab itself and points it at the link read afresh when the queue is older than a poll", async () => {
    await aged(10_000);
    const tab = blankTab();
    const open = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    expect(fireEvent.click(link())).toBe(false);
    expect(open).toHaveBeenCalledWith("", "terminal-A11-183");
    await waitFor(() => expect(tab.location.href).toContain(FRESH));
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("closes the blank tab when the run is over by the time it is read again", async () => {
    const ended = { ...holder, phase: "finished", finishedAt: Date.now(), workspace: undefined, pane: undefined } as RunFields;
    const live = { runs: [holder] };
    const instance: InstanceAnswers = { config: queueingConfig({ terminal: TERMINAL } as never), get queue() { return queueOf(live.runs); } };
    await pageFor("running", { connections: [PERSONAL], instances: { personal: instance } });
    rstest.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    live.runs = [ended];
    const tab = blankTab();
    rstest.spyOn(window, "open").mockReturnValue(tab as never);
    fireEvent.click(link());
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
  });

  it("only points a tab that already shows a terminal, never closing it", async () => {
    await aged(10_000);
    const tab = { closed: false, close: rstest.fn(), location: { href: "https://worker.example/old" } };
    rstest.spyOn(window, "open").mockReturnValue(tab as never);
    fireEvent.click(link());
    await waitFor(() => expect(tab.location.href).toContain(FRESH));
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("follows the link as it is for a click that asks for something else, or when the browser blocks the tab", async () => {
    await aged(10_000);
    const open = rstest.spyOn(window, "open").mockReturnValue(null);
    expect(fireEvent.click(link(), { ctrlKey: true })).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(fireEvent.click(link())).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("when the queue the page draws was read", () => {
  const queue = queueOf([]) as QueueView;

  it("is the poll's own read time when the shell hands it on, however long ago the page drew the queue", () => {
    expect(renderHook(() => useQueueReadAt({ readAt: 1234 }, queue)).result.current).toBe(1234);
  });

  it("is the moment the page drew the queue when the poll names no read time", () => {
    const before = Date.now();
    const at = renderHook(() => useQueueReadAt({}, queue)).result.current;
    expect(at).toBeGreaterThanOrEqual(before);
  });
});
