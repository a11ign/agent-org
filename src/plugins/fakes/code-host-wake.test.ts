// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 7): THE FAKE CODE HOST'S OPERATIONS FOR WAKE. Core's tests of the wake seed `FakeRowsWorld` (rows with comments and labels, the history of a label, pull requests and the merge queue) and call the wake
 * with no `run`; these cases hold what they rely on: a row's title, comments, labels and state, the newest event of a label, a comment's marker, a pull request's state and its seat in the queue, a reference the
 * world does not hold, and the runner a fake has none of.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.rows.set(7, fakeRow(world, 7, { title: "Seven", body: "the body", labels: ["session:worker-7", "ready"], comments: [
    { id: 1, body: "Claimed by worker-7\nbranch: b", createdAt: "2026-10-04T10:00:00Z", author: "the-bot" }, { id: 2, body: "<!-- hold:7 --> text", createdAt: "2026-10-04T11:00:00Z" }] }));
  world.gate.events.set(7, [
    { event: "labeled", label: "answer:ceo", actor: "ceo", at: "2026-10-03T09:00:00Z" },
    { event: "unlabeled", label: "answer:ceo", actor: "the-chairman", at: "2026-10-03T10:00:00Z" },
    { event: "labeled", label: "other", actor: "ceo", at: "2026-10-03T11:00:00Z" },
  ]);
  world.pulls.set(12, { number: 12, body: "", headRefName: "b", labels: ["session:reviewer-1"], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-04T09:00:00Z", comments: [] });
  world.pulls.set(13, { number: 13, body: "", headRefName: "c", labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-10-04T09:30:00Z", createdAt: "2026-10-04T09:00:00Z", comments: [] });
  world.foreignRows.set("a11ign/other#3", fakeRow(world, 3, { title: "Three", labels: ["parked"] }));
  return { world, rows: host.rows! };
}

test("a row's title, comments with their authors, labels, state and body are what the world holds, in the repository named or among another tracker's rows", () => {
  const { rows } = seeded();
  const read = rows.titleAndCommentsOf({ repo: "fake/tracker", number: 7, run: refused });
  assert.equal(read.title, "Seven");
  assert.deepEqual(read.comments.map((c) => [c.body.split("\n")[0], c.createdAt, c.author.login]), [["Claimed by worker-7", "2026-10-04T10:00:00Z", "the-bot"], ["<!-- hold:7 --> text", "2026-10-04T11:00:00Z", undefined]]);
  assert.deepEqual(rows.labelNamesOfRow({ repo: "fake/tracker", number: 7, run: refused }), ["session:worker-7", "ready"]);
  assert.deepEqual(rows.labelsBodyTitleOf({ repo: "fake/tracker", number: 7, run: refused }), { labels: ["session:worker-7", "ready"], body: "the body", title: "Seven" });
  assert.equal(rows.rowStateOf({ number: 7, run: refused }), "OPEN");
  assert.deepEqual(rows.labelNamesOfRow({ repo: "a11ign/other", number: 3, run: refused }), ["parked"], "another tracker's row is asked of that tracker");
  assert.throws(() => rows.labelNamesOfRow({ repo: "fake/tracker", number: 99, run: refused }), /holds no row/, "a row the world does not hold is a refused read, never an empty answer");
  assert.throws(() => rows.labelNamesOfRow({ repo: "a11ign/other", number: 7, run: refused }), /holds no row/, "the same number in another tracker is another row");
});

test("the newest event of a label is the last one the world holds for it, and a label that never had one is null; a refused history throws", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.lastLabelEventOf({ number: 7, label: "answer:ceo", run: refused }), { event: "unlabeled", at: Date.parse("2026-10-03T10:00:00Z"), by: "the-chairman" });
  assert.equal(rows.lastLabelEventOf({ number: 7, label: "never", run: refused }), null);
  assert.equal(rows.lastLabelEventOf({ number: 8, label: "answer:ceo", run: refused }), null, "a row with no history has no event");
  world.gate.events.set(7, new Error("HTTP 403"));
  assert.throws(() => rows.lastLabelEventOf({ number: 7, label: "answer:ceo", run: refused }), /HTTP 403/);
});

test("a row's comments say whether they carry the marker, who wrote each and when", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.markedCommentsOf({ number: 7, marker: "<!-- hold:7 -->", run: refused }), [
    { id: 1, login: "the-bot", at: Date.parse("2026-10-04T10:00:00Z"), marked: false }, { id: 2, login: "", at: Date.parse("2026-10-04T11:00:00Z"), marked: true }]);
  assert.equal(rows.firstCommentTimeStartingWith({ repo: "fake/tracker", number: 7, prefix: "Claimed by", pageSize: 100, run: refused }), "2026-10-04T10:00:00Z");
  assert.equal(rows.firstCommentTimeStartingWith({ repo: "fake/tracker", number: 7, prefix: "nothing starts so", pageSize: 100, run: refused }), null);
});

test("a pull request is closed when it merged or was closed, open otherwise; one the world does not hold is a refused read", () => {
  const { world, rows } = seeded();
  assert.equal(rows.pullStateWordOf({ repo: "fake/tracker", number: 12, run: refused }), "open");
  assert.equal(rows.pullStateWordOf({ repo: "fake/tracker", number: 13, run: refused }), "closed");
  world.pulls.get(12)!.closedAt = "2026-10-05T00:00:00Z";
  assert.equal(rows.pullStateWordOf({ repo: "fake/tracker", number: 12, run: refused }), "closed");
  assert.throws(() => rows.pullStateWordOf({ repo: "fake/tracker", number: 99, run: refused }), /holds no pull request/);
});

test("an issue or pull request is open or not with its labels, and a reference the world does not hold is null (GitHub's 404)", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.issueStateAndLabelsOf({ repo: "fake/tracker", number: 7, run: refused }), { open: true, labels: ["session:worker-7", "ready"] });
  assert.deepEqual(rows.issueStateAndLabelsOf({ repo: "fake/tracker", number: 12, run: refused }), { open: true, labels: ["session:reviewer-1"] });
  assert.deepEqual(rows.issueStateAndLabelsOf({ repo: "fake/tracker", number: 13, run: refused }), { open: false, labels: [] });
  assert.equal(rows.issueStateAndLabelsOf({ repo: "fake/tracker", number: 99999, run: refused }), null);
});

test("a pull request is queued when the world's merge queue holds it; a queue that cannot be read is not a seat", () => {
  const { world, rows } = seeded();
  world.queue.entries = [{ state: "QUEUED", enqueuedAt: "2026-10-04T10:00:00Z", position: 1, headSha: null, pull: 12, pullId: null }];
  assert.equal(rows.isPullQueued({ repo: "fake/tracker", number: 12, run: refused }), true);
  assert.equal(rows.isPullQueued({ repo: "fake/tracker", number: 13, run: refused }), false);
  world.queue.entries = new Error("HTTP 502");
  assert.equal(rows.isPullQueued({ repo: "fake/tracker", number: 12, run: refused }), false);
});

test("the wake's writes land on the world: a row filed with every label, a row closed with its comment", () => {
  const { world, rows } = seeded();
  const url = rows.fileRowWithLabels({ title: "stuck", body: "b", labels: ["answer:ceo", "parked"], run: refused });
  assert.match(url, /\/issues\/\d+\n$/);
  const filed = [...world.rows.values()].find((row) => row.title === "stuck")!;
  assert.deepEqual([filed.labels, filed.state], [["answer:ceo", "parked"], "OPEN"]);
  rows.closeHomeRowWithComment({ number: filed.number, comment: "answered", run: refused });
  assert.deepEqual([filed.state, filed.comments.at(-1)?.body], ["CLOSED", "answered"]);
  assert.throws(() => rows.closeHomeRowWithComment({ number: 99, comment: "x", run: refused }), /holds no row/);
});

test("the fake has no gh: the runner with a bound and a REST read throw, naming why", () => {
  const { rows } = seeded();
  assert.throws(() => rows.ownRunWithin(120_000)(["api", "x"]), /no gh/);
  assert.throws(() => rows.readRestJson({ args: ["x"], run: refused }), /no gh/);
});
