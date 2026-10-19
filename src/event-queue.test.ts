// agent-org#979: the reader of the event queue. Every test writes real files in a scratch directory; the cursor is the thing under test, so nothing is faked.
//
// POSITIVE CONTROL: the first test appends events and requires them read back in order, once; every "nothing is read" assertion below is only worth anything because this one reads something.
// NEGATIVE CONTROL: the unacked read, the half-written line and the unparsable line each assert what is NOT consumed, and the same file is then read again after the remedy (ack, completed line) so the absence is the cursor's and not an unreadable file's.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ackThrough, changedRepos, readNewEvents, scopesOf } from "./event-queue.ts";
import type { QueueLine } from "./event-receiver.ts";

const directories: string[] = [];
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), "event-queue-"));
  directories.push(directory);
  return { queuePath: join(directory, "queue.jsonl"), cursorPath: join(directory, "queue.cursor") };
}
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

const line = (over: Partial<QueueLine> = {}): QueueLine => ({
  deliveryId: "d-1", event: "pull_request", action: "opened", repo: "a11ign/agent-org", number: 7, sha: "abc123", receivedAt: "2026-10-11T14:00:00.000Z", ...over,
});
const append = (queuePath: string, ...lines: QueueLine[]) => appendFileSync(queuePath, lines.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
const ids = (events: QueueLine[]) => events.map((event) => event.deliveryId);

test("POSITIVE CONTROL: events appended to the queue are read back in order, and once acked none are read again", () => {
  const paths = scratch();
  append(paths.queuePath, line({ deliveryId: "d-1" }), line({ deliveryId: "d-2" }));
  const first = readNewEvents(paths);
  assert.deepEqual(ids(first.events), ["d-1", "d-2"]);
  assert.equal(first.unreadable, 0);
  ackThrough({ cursorPath: paths.cursorPath, through: first.through });
  const second = readNewEvents(paths);
  assert.deepEqual(second.events, []);
  append(paths.queuePath, line({ deliveryId: "d-3" }));
  assert.deepEqual(ids(readNewEvents(paths).events), ["d-3"]);
});

test("NEGATIVE CONTROL: an unacked read returns the same events again, and the cursor file is not written", () => {
  const paths = scratch();
  append(paths.queuePath, line({ deliveryId: "d-1" }));
  assert.deepEqual(ids(readNewEvents(paths).events), ["d-1"]);
  assert.equal(existsSync(paths.cursorPath), false, "reading must not create the cursor");
  assert.deepEqual(ids(readNewEvents(paths).events), ["d-1"]);
  const read = readNewEvents(paths);
  ackThrough({ cursorPath: paths.cursorPath, through: read.through });
  assert.deepEqual(readNewEvents(paths).events, []);
});

test("a half-written last line is neither read nor counted, and is read once it is complete", () => {
  const paths = scratch();
  append(paths.queuePath, line({ deliveryId: "d-1" }));
  const whole = JSON.stringify(line({ deliveryId: "d-2" }));
  appendFileSync(paths.queuePath, whole.slice(0, 20));
  const partial = readNewEvents(paths);
  assert.deepEqual(ids(partial.events), ["d-1"]);
  assert.equal(partial.unreadable, 0);
  ackThrough({ cursorPath: paths.cursorPath, through: partial.through });
  appendFileSync(paths.queuePath, `${whole.slice(20)}\n`);
  const completed = readNewEvents(paths);
  assert.deepEqual(ids(completed.events), ["d-2"]);
  assert.equal(completed.unreadable, 0);
});

test("a complete line that does not parse is counted, the lines around it are still read, and a multi-byte character does not shift the cursor", () => {
  const paths = scratch();
  append(paths.queuePath, line({ deliveryId: "d-é" }));
  appendFileSync(paths.queuePath, "{not json\n");
  appendFileSync(paths.queuePath, `${JSON.stringify({ event: "pull_request" })}\n`); // parses, but names no delivery
  append(paths.queuePath, line({ deliveryId: "d-3" }));
  const { events, unreadable, through } = readNewEvents(paths);
  assert.deepEqual(ids(events), ["d-é", "d-3"]);
  assert.equal(unreadable, 2);
  ackThrough({ cursorPath: paths.cursorPath, through });
  assert.deepEqual(readNewEvents(paths), { events: [], unreadable: 0, through });
});

test("a missing queue reads nothing; a queue shorter than the cursor is read from the start; a damaged cursor is read from the start", () => {
  const paths = scratch();
  assert.deepEqual(readNewEvents(paths), { events: [], unreadable: 0, through: 0 });
  append(paths.queuePath, line({ deliveryId: "d-1" }));
  writeFileSync(paths.cursorPath, "999999\n");
  assert.deepEqual(ids(readNewEvents(paths).events), ["d-1"]);
  writeFileSync(paths.cursorPath, "banana\n");
  assert.deepEqual(ids(readNewEvents(paths).events), ["d-1"]);
});

test("ackThrough writes the offset atomically and refuses what is not an offset", () => {
  const paths = scratch();
  ackThrough({ cursorPath: paths.cursorPath, through: 42 });
  assert.equal(readFileSync(paths.cursorPath, "utf8"), "42\n");
  assert.equal(existsSync(`${paths.cursorPath}.tmp`), false, "the temporary file was renamed away");
  assert.throws(() => ackThrough({ cursorPath: paths.cursorPath, through: -1 }));
  assert.throws(() => ackThrough({ cursorPath: paths.cursorPath, through: 1.5 }));
  assert.equal(readFileSync(paths.cursorPath, "utf8"), "42\n");
});

test("two events for one pull request are one scope, in first-seen order", () => {
  const events = [
    line({ deliveryId: "a", event: "pull_request", number: 7 }),
    line({ deliveryId: "b", event: "issues", number: 7 }),
    line({ deliveryId: "c", event: "check_run", number: 7, sha: "def456" }),
    line({ deliveryId: "d", event: "pull_request_review", number: 9 }),
    line({ deliveryId: "e", event: "pull_request", number: 7, repo: "a11ign/other" }),
  ];
  assert.deepEqual(scopesOf(events), [
    { repo: "a11ign/agent-org", kind: "pr", number: 7 },
    { repo: "a11ign/agent-org", kind: "issue", number: 7 },
    { repo: "a11ign/agent-org", kind: "pr", number: 9 },
    { repo: "a11ign/other", kind: "pr", number: 7 },
  ]);
});

test("a check or workflow event with no pull request is the sha scope; a merge group is its own; an event naming nothing is no scope", () => {
  const events = [
    line({ deliveryId: "a", event: "workflow_run", number: null, sha: "def456" }),
    line({ deliveryId: "b", event: "check_suite", number: null, sha: "def456" }),
    line({ deliveryId: "c", event: "merge_group", number: null, sha: "9f9f9f" }),
    line({ deliveryId: "d", event: "check_run", number: null, sha: null }),
    line({ deliveryId: "e", event: "pull_request", repo: null }),
    line({ deliveryId: "f", event: "star", number: 3 }),
  ];
  assert.deepEqual(scopesOf(events), [
    { repo: "a11ign/agent-org", kind: "sha", sha: "def456" },
    { repo: "a11ign/agent-org", kind: "merge-group", sha: "9f9f9f" },
  ]);
});

test("changedRepos lists a repository once, in first-seen order, and none for an event with no repository", () => {
  const events = [line({ repo: "a11ign/b" }), line({ repo: "a11ign/a" }), line({ repo: "a11ign/b" }), line({ repo: null })];
  assert.deepEqual(changedRepos(events), ["a11ign/b", "a11ign/a"]);
  assert.deepEqual(changedRepos([]), []);
});

test("the module makes no network call and starts no process: its import list holds no child_process and no fetch", () => {
  const source = readFileSync(new URL("./event-queue.ts", import.meta.url), "utf8");
  const imports = source.split("\n").filter((entry) => /^\s*import\b/.test(entry));
  assert.ok(imports.length >= 2, "the import lines were found, so the absence below means something");
  for (const entry of imports) assert.doesNotMatch(entry, /child_process|node:http|node:https|node:net/);
  assert.doesNotMatch(source, /\bfetch\(|\bexecSync\b|\bspawn\(/);
});
