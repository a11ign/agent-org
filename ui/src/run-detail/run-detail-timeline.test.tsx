import type { RunEvent } from "../../../src/ticket-mode/queue/run-log.ts";
import { detailStand, RUNS_OF, STATES, type RunFields, type State } from "../../test/run-detail/run-detail-stand.ts";
import { pageFor, screen, textOf, within } from "./run-detail-harness.tsx";
import { timelineOf } from "./run-timeline-model.ts";
import type { RunEntry } from "../runs/runs-model.ts";

const MINUTE = 60_000;
const NOW = 1_000 * MINUTE;
const PULL = "https://github.com/a11ign/lab/pull/150";

const entry = (more: Record<string, unknown> = {}): RunEntry =>
  ({ ticket: { key: "A11-1", title: "t", url: "" }, phase: "running", model: "sonnet", effort: "high", queuedAt: NOW - 60 * MINUTE, ...more }) as unknown as RunEntry;
const rowsOf = (events: readonly RunEvent[], more: Record<string, unknown> = {}) => timelineOf(entry(more), { runLog: { "A11-1": events } }, NOW);

describe("the Timeline's rows", () => {
  it("are newest first, each worded from its own event", () => {
    const rows = rowsOf([
      { at: NOW - 50 * MINUTE, kind: "queued", model: "sonnet", effort: "high", planFirst: true },
      { at: NOW - 40 * MINUTE, kind: "planned", link: null },
      { at: NOW - 30 * MINUTE, kind: "started", model: "opus", effort: "max", instance: "agents" },
      { at: NOW - 25 * MINUTE, kind: "pr-opened", url: PULL },
      { at: NOW - 20 * MINUTE, kind: "verdict", url: PULL, head: "1f6009d3a5c0", review: "approved" },
      { at: NOW - 10 * MINUTE, kind: "finished", outcome: "reviewed" },
    ], { phase: "finished", startedAt: NOW - 30 * MINUTE });
    expect(rows.map(({ text, when, tone }) => [text, when, tone])).toEqual([
      ["Run finished", "after 20m", "grey"],
      ["Approved at 1f6009d", "a11ign/lab #150 · 20 min ago", "green"],
      ["Pull request opened", "a11ign/lab #150 · 25 min ago", "violet"],
      ["Started", "30 min ago · opus/max · on agents", "grey"],
      ["Plan written", "40 min ago", "grey"],
      ["Queued", "50 min ago · sonnet/high · plan first", "grey"],
    ]);
  });

  it("word every other kind of event, and a failed run in red", () => {
    const rows = rowsOf([
      { at: NOW - 9 * MINUTE, kind: "round", cause: "checks", reason: "lint is red" },
      { at: NOW - 8 * MINUTE, kind: "verdict", url: PULL, head: "abcdef0123", review: "changes-requested" },
      { at: NOW - 7 * MINUTE, kind: "needs-you", reason: "Overwrite?" },
      { at: NOW - 6 * MINUTE, kind: "answered", by: "respond" },
      { at: NOW - 5 * MINUTE, kind: "published", link: null },
      { at: NOW - 4 * MINUTE, kind: "merged", url: PULL },
      { at: NOW - 3 * MINUTE, kind: "requeued", why: "next-step" },
      { at: NOW - 2 * MINUTE, kind: "dismissed" },
      { at: NOW - 1 * MINUTE, kind: "removed" },
      { at: NOW - 30_000, kind: "finished", outcome: "crashed", reason: "out of memory" },
    ], { phase: "finished" });
    expect(rows.map(({ text, when, tone }) => [text, when, tone])).toEqual([
      ["Run failed", "just now", "red"],
      ["Removed", "1 min ago", "grey"],
      ["Dismissed", "2 min ago", "grey"],
      ["Queued again", "3 min ago · the next plan step", "grey"],
      ["Pull request merged", "a11ign/lab #150 · 4 min ago", "violet"],
      ["Published", "5 min ago", "violet"],
      ["Answered", "6 min ago · Respond", "grey"],
      ["Waiting on a person", "7 min ago", "amber"],
      ["Changes requested at abcdef0", "a11ign/lab #150 · 8 min ago", "amber"],
      ["Fixing red checks", "9 min ago · lint is red", "amber"],
    ]);
  });

  it("show the newest Started of a run still going in amber, and say a rebuilt event is from the run's times", () => {
    const going = timelineOf(entry({ startedAt: NOW - 52 * MINUTE }), { runLog: {} }, NOW);
    expect(going.map(({ text, tone }) => [text, tone])).toEqual([["Started", "amber"], ["Queued", "grey"]]);
    expect(going[0]?.when).toContain("from the run's times");
  });

  it("end a canceled ticket's run in the Cancelled board's words, and draw nothing for a run with no event", () => {
    const events: RunEvent[] = [{ at: NOW - 3 * MINUTE, kind: "started", model: "sonnet", effort: "high", instance: null }, { at: NOW - 30_000, kind: "finished", outcome: "stopped" }];
    expect(rowsOf(events, { phase: "finished", trackerState: "canceled" })[0]?.text).toBe("Ticket canceled in the tracker");
    expect(rowsOf(events, { phase: "finished" })[0]?.text).toBe("Run finished");
    expect(timelineOf({ ticket: { key: "A11-1" }, phase: "running" } as unknown as RunEntry, {}, NOW)).toEqual([]);
  });
});

/** The words of each board's Timeline, newest first: the first and the last row. */
const BOARD_ROWS: Readonly<Record<Exclude<State, "loading" | "missing">, readonly [string, string]>> = {
  running: ["Started", "Started"], queued: ["Queued", "Queued"], blocked: ["Queued", "Queued"], needs: ["Waiting on a person", "Started"], handback: ["Run finished", "Started"],
  awaiting: ["Pull request opened", "Started"], ready: ["Run finished", "Started"], done: ["Pull request merged", "Started"], failed: ["Run failed", "Started"], cancelled: ["Ticket canceled in the tracker", "Started"],
};

describe("the Timeline on Run detail", () => {
  it.each(STATES.filter((state): state is Exclude<State, "loading" | "missing"> => state !== "loading" && state !== "missing"))("%s draws a Timeline of what the board recorded, after the pull requests", async (state) => {
    await pageFor(state);
    const heading = screen.getByRole("heading", { name: "Timeline" });
    const rows = [...within(heading.closest("section") as HTMLElement).getAllByRole("listitem")].map((row) => textOf(row.querySelector(".timeline-text > div")));
    expect([rows[0], rows.at(-1)]).toEqual([...BOARD_ROWS[state]]);
    const headings = [...document.querySelectorAll("h2")].map((each) => textOf(each));
    expect(headings.indexOf("Timeline")).toBeGreaterThan(headings.indexOf("Pull requests"));
    expect(textOf(heading.closest("section"))).not.toContain("from the run's times");
  });

  it("draws the events a run's own times rebuild when the board recorded none, and says so", async () => {
    const run = RUNS_OF.done.runs[0] as RunFields;
    await pageFor("done", detailStand("done", { runs: [run] }));
    const section = screen.getByRole("heading", { name: "Timeline" }).closest("section") as HTMLElement;
    expect(textOf(section)).toContain("from the run's times");
    expect(within(section).getAllByRole("listitem").length).toBeGreaterThan(1);
  });
});
