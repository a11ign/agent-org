// no-token: none -- a board over a stub pool, a fake tracker and a temporary state directory, served on a Unix socket in a temporary directory
// A11-270: the queue the pages poll is a list of what they draw (under 200 KB on the wire for a queue shaped like the agents host's, which was 1.1 MB), and one run is read in full on demand
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import { currentStepOf } from "./board-view/plan-steps.ts";
import { unlistedPulls } from "./board-view.ts";
import { cutListNote, footprintOf, overlapWait } from "./board-view/overlap-hold.ts";
import { readoptNote } from "./board-view/readopt-note.ts";
import { reasonOf } from "./board-view/run-reason.ts";
import { shownStatus, stackedOn, waitNote, waitsOn } from "./board-view/pull-status-and-notes.ts";
import { learnsLine, ticketChangeLine } from "./board-view/ticket-change.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { hostShapedQueue, serveBoard, type Served } from "./queue-view-fixture.ts";
import { listEntry, LIST_FIELDS, queueView, shownEntry, type QueueEntryView, type QueueView } from "./queue-view.ts";

/** What a client sends the instance: the key and the host the instance answers to, as the page's service does, and `Accept-Encoding: gzip` unless `packed` is false. */
function read(served: Served, path: string, packed = true) {
  return new Promise<{ status: number; encoding: string | undefined; wireBytes: number; body: string }>((done, fail) => {
    const headers = { host: served.host, "x-ticket-token": served.key, ...(packed ? { "accept-encoding": "gzip" } : {}) };
    request({ socketPath: served.socket, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const wire = Buffer.concat(chunks);
        done({ status: response.statusCode ?? 0, encoding: response.headers["content-encoding"], wireBytes: wire.length, body: (response.headers["content-encoding"] === "gzip" ? gunzipSync(wire) : wire).toString("utf8") });
      });
    }).on("error", fail).end();
  });
}

const queue = hostShapedQueue();
const served = await serveBoard({ queue });
const fullView = JSON.stringify({ ...queue, entries: queue.entries.map(shownEntry) });

test("A11-270: the queue read is the runs' list fields, a third of the full queue or less, and under 200 KB on the wire", async () => {
  const answer = await read(served, "/api/queue");
  assert.equal(answer.status, 200);
  assert.equal(answer.encoding, "gzip", "the instance packs an answer this size for a client that takes gzip");
  assert.ok(answer.wireBytes < 200 * 1024, `the read is ${answer.wireBytes} bytes on the wire`);
  assert.ok(answer.body.length < fullView.length / 3, `the list is ${answer.body.length} bytes of JSON, the full queue ${fullView.length}`);
  const plain = await read(served, "/api/queue", false);
  assert.equal(plain.encoding, undefined, "a client that does not take gzip is sent the text as it was");
  assert.equal(plain.body, answer.body, "and the same text");
});

test("A11-270: a run in the list has its ticket's key, title and address and no log; its description and the rest are in its full read", async () => {
  const view = JSON.parse((await read(served, "/api/queue")).body) as QueueView;
  assert.equal(view.entries.length, queue.entries.length, "every run is listed");
  assert.equal("runLog" in view, false);
  assert.deepEqual(view.openedPullLog, Object.fromEntries(Object.entries(queue.runLog ?? {}).flatMap(([key, events]) => { const opened = events.filter(({ kind }) => kind === "pr-opened"); return opened.length === 0 ? [] : [[key, opened]]; })), "the log is sent as far as the Runs page reads it: the events that opened a pull request");
  assert.ok(Object.keys(view.openedPullLog).length > 0 && Object.values(view.openedPullLog).every((events) => events.every(({ kind }) => kind === "pr-opened")));
  const first = view.entries[0];
  assert.deepEqual(Object.keys(first.ticket).sort(), ["branch", "key", "title", "url"]);
  for (const entry of view.entries) for (const field of Object.keys(entry)) assert.ok(([...LIST_FIELDS, "ci"] as string[]).includes(field), `${entry.ticket.key} sends ${field}`);
  assert.equal(view.entries.some((entry) => "feedback" in entry || "plannedSteps" in entry || "session" in entry), false, "what only a run's own page draws is not listed");
});

test("A11-270: a run's full read is its whole entry with its log, a ticket the queue holds no run of is a 404, and a write to the path is no route", async () => {
  const key = queue.entries[3].ticket.key;
  const answer = await read(served, `/api/queue/${key}`);
  assert.equal(answer.status, 200);
  const full = JSON.parse(answer.body) as QueueEntryView;
  assert.deepEqual(full.entry, JSON.parse(JSON.stringify(shownEntry(queue.entries[3]))), "the entry is the one the queue holds, without the copies of its ticket the board keeps to tell a change by");
  assert.equal(full.entry.ticket.description, queue.entries[3].ticket.description);
  assert.deepEqual(full.runLog, queue.runLog?.[key]);
  assert.equal((await read(served, "/api/queue/A11-99999")).status, 404);
  assert.equal((await read(served, "/api/queue/A11-1%2Fextra")).status, 404, "an encoded slash is no key");
});

test("A11-270: a run that holds and contests no path sends none of the files it once did, and keeps which step it was on", () => {
  const settled = queue.entries.find((entry) => entry.phase === "finished" && entry.trackerState === "completed") as Entry;
  assert.ok(settled.paths !== undefined && settled.pullFiles !== undefined, "the fixture's settled run has files");
  const sent = listEntry(settled);
  assert.equal("paths" in sent || "pullFiles" in sent, false);
  assert.equal(currentStepOf(sent), currentStepOf(settled), "the step it was on is told by stepPaths' keys, which stay");
  for (const phase of ["finished", "queued", "running"] as const) {
    const holder = queue.entries.find((entry) => entry.phase === phase && entry.trackerState !== "completed") as Entry;
    const kept = listEntry(holder);
    assert.deepEqual([kept.paths, kept.pullFiles, kept.stepPaths], [holder.paths, holder.pullFiles, holder.stepPaths], `a ${phase} run on an open ticket keeps its files`);
  }
});

test("A11-270: what a queued run learns from is sent for a queued run alone, and what a blocker's pull requests declared for a run with a blocker not completed", () => {
  const queued = queue.entries.find((entry) => entry.phase === "queued") as Entry;
  const open = queue.entries.find((entry) => entry.phase === "running") as Entry;
  assert.ok(listEntry(queued).learned !== undefined && listEntry(open).learned === undefined);
  assert.equal(listEntry(queued).blockersDeclared, undefined, "every blocker of the fixture's run is completed, so nothing looks at what they declared");
  const waiting = { ...queued, blockers: [{ key: "A11-1", state: "started", status: "In Progress", pulls: {} }] } as Entry;
  assert.deepEqual(listEntry(waiting).blockersDeclared, waiting.blockersDeclared);
});

/** Whether a run's files are read: it is queued or live, or its ticket is still open (`holds`, `contested`). */
const holdsPaths = (entry: { phase: string; trackerState?: string }): boolean => entry.phase !== "finished" || entry.trackerState !== "completed";

test("A11-270: the rows the pages word are the same from the list as from the full queue", () => {
  const view = queueView({ store: { get: () => queue }, pool: {}, update: () => ({ version: null, note: null, next: null }), settings: { ciBudgetMinutes: 0, stateDir: served.dir } } as unknown as Parameters<typeof queueView>[0]);
  const wordings = (entries: readonly Parameters<typeof shownStatus>[0][]) => entries.map((entry) => ({
    status: shownStatus(entry, undefined, entries), waits: waitsOn(entry, entries), stacked: stackedOn(entry, entries), wait: waitNote(entry, entries), overlap: overlapWait(entry, entries), cut: cutListNote(entry, entries),
    footprint: holdsPaths(entry) ? footprintOf(entry) : null, reason: reasonOf(entry, queue.entries[0].queuedAt + 1e9).line, learns: learnsLine(entry), change: ticketChangeLine(entry), readopted: readoptNote(entry), step: currentStepOf(entry),
  }));
  const fromList = wordings(view.entries);
  assert.deepEqual(fromList, wordings(queue.entries.map(shownEntry)));
  // 1246 is a pull request only a queued run's log says the board opened; 1247 and 9 belong to no run.
  const reviews = { "https://github.com/a11ign/agent-org/pull/1246": "approved", "https://github.com/a11ign/agent-org/pull/1247": "approved", "https://github.com/a11ign/agent-org/pull/9": "approved" };
  const unlisted = unlistedPulls(view.entries, reviews, view.openedPullLog);
  assert.deepEqual(unlisted, unlistedPulls(queue.entries, reviews, queue.runLog), "the pull requests no run lists are the same from the list as from the full log");
  assert.deepEqual(unlisted.map(({ url }) => url.split("/").at(-1)), ["1247", "9"]);
  assert.ok(fromList.some((row) => row.wait !== null) && fromList.some((row) => row.learns !== null) && fromList.some((row) => row.readopted !== null) && fromList.some((row) => row.change !== null), "the fixture draws every kind of line compared");
});

after(() => served.close());
