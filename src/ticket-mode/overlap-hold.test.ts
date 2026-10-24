// no-token: gh -- the queue and the board's words, in memory; nothing is read or spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { overlapWait } from "./board-view/overlap-hold.ts";
import { runStatus, waitNote } from "./board-view/pull-status-and-notes.ts";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";
import { enqueue } from "./queue/queue-entries-and-outcomes.ts";
import { markRunning, markStarting, recordPaths, resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue, nextStarts } from "./queue.ts";
import type { Ticket } from "./source.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const choice = { model: "opus", effort: "high" };

/** A queue of `plans`' tickets (key to paths), each plan read, with room for all of them. */
const queued = (plans: Record<string, string[]>) =>
  recordPaths(resumeQueue(enqueue(emptyQueue(Object.keys(plans).length), Object.keys(plans).map(ticket), choice, 1)), new Map(Object.entries(plans)));

/** A run running with `paths` held, beside a queued run waiting on `waitingPaths`. */
function holderAndWaiter(holds: string[], waitingPaths: string[]) {
  const both = markRunning(markStarting(queued({ "A11-196": holds, "A11-200": waitingPaths }), "A11-196", 2), "A11-196", "w1", "w1:p1");
  return both.entries;
}

const SETTINGS_PAGE = ["agent-org:ui/src/pages/settings/", "agent-org:ui/test/settings/", "agent-org:ui/captures/settings/"];
const TICKETS_PAGE = ["agent-org:ui/src/pages/tickets/", "agent-org:ui/test/tickets/", "agent-org:ui/captures/tickets/"];

test("A11-212: two plans with per-feature paths run side by side, and neither card has a wait note", () => {
  const both = queued({ "A11-196": TICKETS_PAGE, "A11-200": SETTINGS_PAGE });
  assert.deepEqual(nextStarts(both, 0, 14).map((e) => e.ticket.key), ["A11-196", "A11-200"], "both start in one pass");
  assert.deepEqual(both.entries.map((e) => waitNote(e, both.entries)), [null, null]);
  const running = holderAndWaiter(TICKETS_PAGE, SETTINGS_PAGE);
  assert.equal(overlapWait(running[1], running), null, "and a run already running does not hold the other");
  assert.equal(runStatus(running[1], running), "queued");
});

test("A11-212: the A11-200 morning: whole folders held by a running ticket hold a ticket that needs one file in each, and the card says why", () => {
  const entries = holderAndWaiter(["agent-org:ui/src/shell/", "agent-org:ui/test/", "agent-org:ui/captures/"], ["agent-org:ui/src/shell/App.tsx", "agent-org:ui/test/fixtures.ts", "agent-org:ui/captures/settings/home.png"]);
  assert.equal(runStatus(entries[1], entries), "blocked");
  assert.equal(waitNote(entries[1], entries),
    "Waits on A11-196: both touch ui/src/shell/App.tsx, ui/test/fixtures.ts, ui/captures/settings/home.png; a folder claim, not a shared file: narrow A11-196's `ui/src/shell/`, `ui/test/`, `ui/captures/` in its plan");
});

test("A11-212: the card names every file both write, not only the first", () => {
  const files = ["agent-org:ui/src/shell/App.tsx", "agent-org:ui/test/fixtures.ts"];
  const entries = holderAndWaiter(files, files);
  assert.equal(waitNote(entries[1], entries), "Waits on A11-196: both touch ui/src/shell/App.tsx, ui/test/fixtures.ts");
  assert.deepEqual(overlapWait(entries[1], entries)?.overlaps, [
    { path: "ui/src/shell/App.tsx", folderOf: null, folder: null },
    { path: "ui/test/fixtures.ts", folderOf: null, folder: null },
  ]);
});

test("A11-212: a hold caused by a folder claim alone is flagged as one to narrow, naming whose folder; one shared file takes the flag away", () => {
  const folderOnly = holderAndWaiter(["agent-org:ui/src/shell/"], ["agent-org:ui/src/shell/App.tsx"]);
  assert.equal(waitNote(folderOnly[1], folderOnly), "Waits on A11-196: both touch ui/src/shell/App.tsx; a folder claim, not a shared file: narrow A11-196's `ui/src/shell/` in its plan");
  const own = holderAndWaiter(["agent-org:ui/src/shell/App.tsx"], ["agent-org:ui/src/shell/"]);
  assert.equal(waitNote(own[1], own), "Waits on A11-196: both touch ui/src/shell/App.tsx; a folder claim, not a shared file: narrow A11-200's `ui/src/shell/` in its plan", "the waiting ticket's own folder is the one to narrow");
  const shared = holderAndWaiter(["agent-org:ui/src/shell/", "agent-org:ui/test/fixtures.ts"], ["agent-org:ui/src/shell/App.tsx", "agent-org:ui/test/fixtures.ts"]);
  assert.equal(waitNote(shared[1], shared), "Waits on A11-196: both touch ui/src/shell/App.tsx, ui/test/fixtures.ts", "a file both name is shared for real, so nothing is flagged");
});

test("A11-212: a folder inside another's folder overlaps at the narrower folder, and the one whose folder is wider is the one to narrow", () => {
  const entries = holderAndWaiter(["agent-org:ui/test/"], ["agent-org:ui/test/settings/"]);
  assert.equal(waitNote(entries[1], entries), "Waits on A11-196: both touch ui/test/settings/; a folder claim, not a shared file: narrow A11-196's `ui/test/` in its plan");
});

test("A11-212: a hold is still one hold: the first run that overlaps is named, and `path`, which Start anyway records, is still the waiting run's own first overlapping claim", () => {
  const entries = holderAndWaiter(["agent-org:ui/src/shell/App.tsx"], ["agent-org:ui/src/shell/", "agent-org:docs/"]);
  const wait = overlapWait(entries[1], entries);
  assert.deepEqual([wait?.key, wait?.pull, wait?.path], ["A11-196", null, "ui/src/shell/"]);
  assert.deepEqual(wait?.overlaps.map(({ path }) => path), ["ui/src/shell/App.tsx"], "while the card names the file");
});

test("A11-212: a run held for a pull request whose files are not read yet names no path and no folder, as before", () => {
  const url = "https://github.com/a11ign/agent-org/pull/12";
  const holder = { ticket: { key: "A11-196" }, phase: "finished", paths: [], outcome: { kind: "draft-pr", prs: [{ url, repo: "agent-org" }] } } as unknown as ViewEntry;
  const waiting = { ticket: { key: "A11-200" }, phase: "queued", paths: ["agent-org:ui/src/a.ts"] } as unknown as ViewEntry;
  const wait = overlapWait(waiting, [holder, waiting]);
  assert.deepEqual(wait, { key: "A11-196", pull: "12", path: null, overlaps: [] });
  assert.equal(waitNote(waiting, [holder, waiting]), "Waits on A11-196 #12: its changed files are not read yet");
});
