import { RUN_STATUSES } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { clockOf } from "../../../src/ticket-mode/board-view/update-banner.ts";
import { BACKGROUND_WAIT_MS } from "../../../src/ticket-mode/board-view/wait-deadline.ts";
import { boardRuns, queueWith, queuedRun, working, type RunFields } from "../../test/runs/runs-stand.ts";
import type { QueueView } from "../api/types.ts";
import {
  countText, filteredRuns, filterFrom, footerOf, groupsOf, holdsSlot, length, noteLines, noteOf, paged, PAGE_SIZE, poolOf, poolWords, railOf, RAIL_HEADS, since, timingOf, tokensOf, type RunEntry,
} from "./runs-model.ts";

const queueOf = (runs: readonly RunFields[], more: Parameters<typeof queueWith>[1] = {}): QueueView => queueWith(runs, more);
const entryOf = (fields: RunFields): RunEntry => fields as unknown as RunEntry;
const MINUTE = 60_000;

describe("the rail", () => {
  it("has heads that hold every status of RUN_STATUSES, once, in its order", () => {
    expect(RAIL_HEADS.flatMap(({ statuses }) => statuses)).toEqual(RUN_STATUSES.map(({ status }) => status));
    expect(RAIL_HEADS.map(({ label }) => label)).toEqual(["Attention", "Active", "Delivery", "Finished"]);
  });

  it("lists every status with its count, and the queue's size for All runs, from statusCounts", () => {
    const rail = railOf(queueOf(boardRuns()));
    const counts = Object.fromEntries(rail.heads.flatMap(({ items }) => items.map(({ label, count }) => [label, count])));
    expect(rail.all).toBe(90);
    expect(counts).toMatchObject({ "Needs you": 0, "In progress": 2, Planning: 1, "Ready to merge": 1, Checked: 1, Completed: 85, Failed: 0 });
    expect(rail.heads.flatMap(({ items }) => items)).toHaveLength(17);
  });

  it("lists Approved, not merging in the Delivery head, right after Awaiting review (A11-291)", () => {
    const delivery = railOf(queueOf(boardRuns())).heads.find(({ label }) => label === "Delivery");
    expect(delivery?.items.map(({ label }) => label).slice(0, 3)).toEqual(["Awaiting review", "Approved, not merging", "Ready to merge"]);
    expect(filterFrom("not-merging")).toBe("not-merging");
  });

  it("takes a remembered status, and All runs for anything else", () => {
    expect(filterFrom("failed")).toBe("failed");
    expect(filterFrom("nonsense")).toBeNull();
    expect(filterFrom(null)).toBeNull();
  });
});

describe("a run parked on a wait (A11-272)", () => {
  const parked = (key: string, more: RunFields = {}) => working({ key, title: key, startedAgo: MINUTE, working: { reason: "waits", at: Date.now(), waiting: true, waits: [{ kind: "ticket", key: "A11-229" }], waitText: "Waiting on ticket A11-229 (In Progress)" }, ...more });

  it("is listed under Waiting in the Active head, just after In progress, and counted there and not under In progress", () => {
    const rail = railOf(queueOf([parked("A11-231"), working({ key: "A11-1", title: "at work", startedAgo: MINUTE })]));
    const active = rail.heads.find(({ label }) => label === "Active");
    expect(active?.items.map(({ label, count }) => [label, count]).slice(0, 3)).toEqual([["In progress", 1], ["Waiting", 1], ["Planning", 0]]);
  });

  it("holds a worker slot, in the In progress colour, and sits under Running now", () => {
    const queue = queueOf([parked("A11-231")], { max: 2 });
    expect(poolOf(queue)).toMatchObject({ slots: ["working", "free"], busy: 1, text: "1 of 2 busy" });
    expect(groupsOf(queue, filteredRuns(queue, null)).map(({ label, count }) => [label, count])).toEqual([["Running now", 1]]);
    expect(filteredRuns(queue, "waiting").map(({ ticket }) => ticket.key)).toEqual(["A11-231"]);
    expect(filteredRuns(queue, "working")).toEqual([]);
  });

  it("says what it waits on and until when in its note, and never In progress or Working", () => {
    const queue = queueOf([parked("A11-231")]);
    const note = noteOf(entryOf(parked("A11-231")), { queue, publisher: undefined, now: Date.now() });
    expect(note).toMatch(/^Waiting on ticket A11-229 \(In Progress\), until \d\d:\d\d$/);
    expect(note).not.toMatch(/In progress|Working/);
  });

  it("names the wait cycle a queued ticket is in, on its card", () => {
    const files = ["lab:middleware/runtime/main.py"];
    const queue = queueOf([parked("A11-231", { paths: files }), queuedRun("A11-229", "held", MINUTE, { paths: files })]);
    expect(noteLines(entryOf(queue.entries[1] as never), { queue, publisher: undefined })).toContain("in a wait cycle: A11-229 → A11-231 → A11-229");
  });
});

describe("the groups", () => {
  const live = (phase: string, more: RunFields = {}) => ({ ...working({ key: `A11-${phase}`, title: phase, startedAgo: MINUTE }), phase, ...more });

  it("puts every run that holds a slot under Running now, a waiting Needs you run among them", () => {
    const runs = [live("starting"), live("running"), { ...live("running"), ticket: { key: "A11-wait", title: "w" }, waiting: true }, queuedRun("A11-q", "queued")];
    const queue = queueOf(runs);
    const groups = groupsOf(queue, filteredRuns(queue, null));
    expect(groups.map(({ label, count }) => [label, count])).toEqual([["Running now", 3], ["Queued", 1]]);
    expect(groups[0]?.runs.every(holdsSlot)).toBe(true);
    expect(groups[0]?.runs.map(({ ticket }) => ticket.key)).toContain("A11-wait");
  });

  it("sits every other run under its own status, in RUN_STATUSES order, and draws no group without runs", () => {
    const queue = queueOf(boardRuns());
    const groups = groupsOf(queue, filteredRuns(queue, null));
    expect(groups.map(({ label, count }) => [label, count])).toEqual([["Running now", 3], ["Ready to merge", 1], ["Checked", 1], ["Completed", 85]]);
  });

  it("counts a group's heading over the filter, in the order runsShown gives", () => {
    const queue = queueOf(boardRuns());
    const groups = groupsOf(queue, filteredRuns(queue, "completed"));
    expect(groups.map(({ label, count }) => [label, count])).toEqual([["Completed", 85]]);
    expect(groups[0]?.runs[0]?.ticket.key).toBe("A11-179");
  });
});

describe("the pages", () => {
  const queue = queueOf(boardRuns());
  const groups = groupsOf(queue, filteredRuns(queue, null));

  it("draws 50 rows, then 100 for one Load more, counted over the runs the filter shows", () => {
    expect(PAGE_SIZE).toBe(50);
    const first = paged(groups, PAGE_SIZE);
    expect([first.shown, first.total]).toEqual([50, 90]);
    expect(footerOf(first)).toBe("Showing the latest 50 of 90 runs");
    const all = paged(groups, 2 * PAGE_SIZE);
    expect([all.shown, all.total]).toEqual([90, 90]);
    expect(footerOf(all)).toBeNull();
  });

  it("keeps a group's count whole when its rows are cut, and draws no group the limit does not reach", () => {
    const cut = paged(groups, 4);
    expect(cut.groups.map(({ label, count, runs }) => [label, count, runs.length])).toEqual([["Running now", 3, 3], ["Ready to merge", 1, 1]]);
    expect(paged(groups, 5).groups.map(({ label }) => label)).toEqual(["Running now", "Ready to merge", "Checked"]);
  });

  it("counts the footer over the filter, not the queue", () => {
    const completed = paged(groupsOf(queue, filteredRuns(queue, "completed")), PAGE_SIZE);
    expect(footerOf(completed)).toBe("Showing the latest 50 of 85 runs");
  });

  it("has no footer for a filter with no runs", () => {
    expect(footerOf(paged(groupsOf(queue, filteredRuns(queue, "failed")), PAGE_SIZE))).toBeNull();
  });
});

describe("the header and the pool", () => {
  it("reads the count line as the badge counts, and 0 total for no run", () => {
    expect(countText(90, 3)).toBe("90 total · 3 running");
    expect(countText(0, 0)).toBe("0 total");
  });

  it("fills one slot for each run holding one, purple for Planning, in the order of Running now", () => {
    const pool = poolOf(queueOf(boardRuns()));
    expect(pool.text).toBe("3 of 10 busy");
    expect(pool.slots.filter((slot) => slot === "free")).toHaveLength(7);
    expect(pool.slots.slice(0, 3).sort()).toEqual(["planning", "working", "working"]);
  });

  it("draws more squares than the limit when more runs hold a slot than it says", () => {
    expect(poolOf(queueOf(boardRuns(), { max: 2 })).slots).toHaveLength(3);
    expect(poolOf(queueOf(boardRuns(), { max: 2 })).text).toBe("3 of 2 busy");
  });

  it("says what paused and started workers do", () => {
    expect(poolWords("paused")).toEqual({ title: "Workers paused", note: "Nothing queued will start.", button: "Start workers" });
    expect(poolWords("started")).toEqual({ title: "Workers started", note: "Queued tickets start as slots free up.", button: "Pause" });
  });
});

describe("a row's timing and tokens", () => {
  const now = Date.now();
  it("says Running and Started for a run at work, Ran for one that finished", () => {
    expect(timingOf({ phase: "running", queuedAt: now - 6 * MINUTE, startedAt: now - 5 * MINUTE }, now)).toEqual({ timing: "Running 5m", started: "Started 5 min ago" });
    expect(timingOf({ phase: "finished", queuedAt: now - 89 * MINUTE, startedAt: now - 88 * MINUTE, finishedAt: now - 41 * MINUTE }, now)).toEqual({ timing: "Ran 47m", started: "Started 1 h 28 min ago" });
  });

  it("says Queued for a run not started, with no second line", () => {
    expect(timingOf({ phase: "queued", queuedAt: now - 3 * MINUTE }, now)).toEqual({ timing: "Queued 3 min ago", started: null });
  });

  it("writes lengths and ages as ui.html does", () => {
    expect(length(524 * MINUTE)).toBe("8 h 44m");
    expect(since(0, 588 * MINUTE)).toBe("9 h 48 min");
  });

  it("writes tokens in k below a million and M from a million", () => {
    expect(tokensOf({ tokens: { input: 74_200_000, output: 189_000 } })).toBe("74.2M in · 189k out");
    expect(tokensOf({ tokens: { input: 8_300_000, output: 41_000 } })).toBe("8.3M in · 41k out");
    expect(tokensOf({ tokens: { input: 999_800, output: 400 } })).toBe("1.0M in · 0k out");
    expect(tokensOf({})).toBeNull();
  });
});

describe("a row's note", () => {
  const queue = queueOf([]);
  const context = { queue, publisher: undefined } as const;

  it("is every line the card shows, in the card's order, joined with a middle dot", () => {
    const entry = entryOf({
      ...working({ key: "A11-1", title: "t", startedAgo: MINUTE }), phase: "finished", workspace: "ws", sessionNote: "closed the leftover of an earlier session",
      outcome: { kind: "needs-human", reason: "which of the two?", edit: { why: "the title is wrong" } }, verdictNotPosted: "the verdict is not on the pull request",
    });
    const lines = noteLines(entry, context);
    expect(lines.at(0)).toBe("closed the leftover of an earlier session");
    expect(lines.indexOf("Proposed edit to the ticket: the title is wrong")).toBeGreaterThan(0);
    expect(lines.indexOf("the verdict is not on the pull request")).toBeGreaterThan(lines.indexOf("Proposed edit to the ticket: the title is wrong"));
    expect(lines.at(-1)).toBe("Still open: answer the agent in its terminal and the run carries on");
    expect(noteOf(entry, context)).toBe(lines.join(" · "));
  });

  it("says a pull request the merge queue removed, among the lines, while the pull request is open and the run is finished (A11-264)", () => {
    const url = "https://github.com/a11ign/announcement-emulator/pull/18";
    const held = { [url]: { head: "c3f2b457", step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware" } };
    const entry = entryOf({
      ...working({ key: "A11-3", title: "t", startedAgo: MINUTE }), phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "announcement-emulator", url }] }, queueHeads: held,
    });
    expect(noteLines(entry, context)).toContain("removed from the merge queue 3 times: middleware");
    expect(noteOf(entry, context)).toContain("removed from the merge queue 3 times: middleware");
    expect(noteLines({ ...entry, phase: "running" } as RunEntry, context)).not.toContain("removed from the merge queue 3 times: middleware");
    expect(noteLines({ ...entry, pullStates: { [url]: "merged" } } as RunEntry, context)).not.toContain("removed from the merge queue 3 times: middleware");
    expect(noteLines({ ...entry, queueHeads: undefined } as RunEntry, context).some((line) => line.includes("merge queue"))).toBe(false);
  });

  it("says what the run's pushes cost in CI, among the lines, with the ticket's total and the budget when they differ or are passed (A11-261)", () => {
    const ci = { run: { pushes: 3, jobs: 48, weighted: 184 }, ticket: { pushes: 3, jobs: 48, weighted: 184 }, budget: 300, state: "ok" as const };
    const entry = entryOf({ ...working({ key: "A11-4", title: "t", startedAgo: MINUTE }), ci });
    expect(noteLines(entry, context)).toContain("CI: 3 pushes, 48 jobs, ~184 min");
    expect(noteLines({ ...entry, ci: { ...ci, ticket: { pushes: 5, jobs: 70, weighted: 340 }, state: "over" } } as RunEntry, context)).toContain("CI: 3 pushes, 48 jobs, ~184 min (ticket ~340 min) · over budget (300)");
    expect(noteLines({ ...entry, ci: undefined } as RunEntry, context).some((line) => line.startsWith("CI:"))).toBe(false);
  });

  it("says when the board took a live pane back after a restart (A11-240)", () => {
    const entry = entryOf({ ...working({ key: "A11-6", title: "t", startedAgo: MINUTE }), readopted: { at: new Date(2026, 9, 24, 22, 31).getTime(), from: "starting" } });
    expect(noteLines(entry, context)).toContain("re-adopted after a restart at 22:31: its worker carried on");
  });

  it("holds a done run's evidence lines, one each, and the pool's review line of an open pull request", () => {
    const done = entryOf({ ...working({ key: "A11-2", title: "t", startedAgo: MINUTE }), phase: "finished", outcome: { kind: "done", reason: "r", evidence: ["ran the test: 3 passed", "read the doc"] } });
    expect(noteLines(done, context)).toEqual(expect.arrayContaining(["ran the test: 3 passed", "read the doc"]));
    const ready = boardRuns().find((run) => (run.ticket as { key: string }).key === "A11-180") as RunFields;
    expect(noteOf(entryOf(ready), { queue: queueOf([ready]), publisher: undefined })).toBe("a11ign/lab #150: approved at 1f6009d");
  });

  it("reads a queue from an older instance that sends no update and no pulls, as the legacy board does", () => {
    const older = { entries: [], max: 10, paused: false } as unknown as QueueView;
    const entry = entryOf({ ...working({ key: "A11-5", title: "t", startedAgo: MINUTE }), phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "a11ign/lab", url: "https://github.com/a11ign/lab/pull/9" }] } });
    expect(() => noteLines(entry, { queue: older, publisher: undefined })).not.toThrow();
  });

  it("says a run waiting on background work waits, for how long when the page holds the time, and a run past its bound is stalled naming the job", () => {
    const base = working({ key: "A11-236", title: "t", startedAgo: 120 * MINUTE });
    const waiting = entryOf({ ...base, working: { reason: "the captures run", at: 0, waiting: true, waitingOn: "the fleet captures" } });
    const until = `, until ${clockOf(0 + BACKGROUND_WAIT_MS)}`;
    expect(noteLines(waiting, { ...context, now: 54 * MINUTE })).toContain(`Waiting on background work for 54 min: the fleet captures${until}`);
    expect(noteLines(waiting, context)).toContain(`Waiting on background work: the fleet captures${until}`);
    const stalled = entryOf({ ...base, working: { reason: "the captures run", at: 0, stalled: true, stallReason: "waited past 2026-10-24T23:00:00.000Z on the fleet captures" } });
    expect(noteLines(stalled, { ...context, now: 54 * MINUTE })).toContain("Stalled: waited past 2026-10-24T23:00:00.000Z on the fleet captures since it said: the captures run");
  });

  it("is null for a run with nothing to say", () => {
    expect(noteOf(entryOf(working({ key: "A11-3", title: "t", startedAgo: MINUTE })), context)).toBeNull();
  });

  it("names what a queued run waits on", () => {
    const blocker = { key: "A11-9", status: "In Progress", type: "started" };
    const entry = entryOf({ ...queuedRun("A11-4", "t"), blockers: [blocker] });
    expect(noteOf(entry, { queue: queueOf([entry as unknown as RunFields]), publisher: undefined })).toContain("Waits on A11-9 (In Progress)");
  });
});
