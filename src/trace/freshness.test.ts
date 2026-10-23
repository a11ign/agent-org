// a11ign/agent-org#498: the trace store's own clock and the signal that it has stopped. Fixtures only: a scratch home (transcripts, wake ledger, store), a fixture host declaration, and a
// `gh` that records a call and fails, so "calls no GitHub" is a measured absence. Nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- the CLI cases run with a PATH whose `gh` is a recorder that exits 1; the incident's own `gh` is injected as a recording effect
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, afterEach, test } from "node:test";
import { DEFERRAL_LOG_FILE } from "../deferral-log.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import {
  advance, checkAndRaise, episodeFileFor, freshnessLine, hostEffects, incidentComment, INCIDENT_CLASS, INCIDENT_ROW, incidentOrder, ingestThenCheck, NO_EPISODE, newestMessageAt, newestTurnAt, OWED_AFTER_MS, sessionsWorking, STALE_AFTER_MS, storeFreshness, transcriptRoots,
} from "./freshness.ts";
import type { Effects } from "./freshness.ts";
import { readStore } from "./store.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { homeProjectDeclaration } from "../project-config.ts";

const MINUTE = 60 * 1000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
/** A `turn` line; `transcript` is the key the store's turn carries for a Claude transcript (the file's name without `.jsonl`). */
const turn = (id: string, at: number, transcript?: string) => JSON.stringify({ id, kind: "turn", at, ...(transcript === undefined ? {} : { transcript }) });
const other = (id: string, at: number) => JSON.stringify({ id, kind: "gh_call", at });
const writeStore = (path: string, lines: string[]) => writeFileSync(path, `${lines.join("\n")}\n`);
/** A transcript line. An `assistant` line carries `message.usage`, as Claude Code writes it, so the store builds a turn from it; a `user` line (a prompt or a tool's result) makes none. */
const message = (type: "assistant" | "user", at: number) => JSON.stringify({ type, timestamp: new Date(at).toISOString(), uuid: `u${at}`, message: { role: type, content: "x", ...(type === "assistant" ? { usage: { input_tokens: 1, output_tokens: 1 } } : {}) } });
const attachment = (at: number) => JSON.stringify({ type: "attachment", timestamp: new Date(at).toISOString(), attachment: { type: "total_tokens_reminder" } });
const bookkeeping = () => [JSON.stringify({ type: "last-prompt", lastPrompt: "x", sessionId: "s" }), JSON.stringify({ type: "cost-state", sessionId: "s", totalCostUSD: 1 })];
const setMtime = (path: string, at: number) => utimesSync(path, new Date(at), new Date(at));

/** A scratch home with one transcript (`session.jsonl`, so its turns are keyed `session`), and a store beside the cache directory the tool names. */
function home() {
  const dir = tmpDir("freshness-");
  const claude = join(dir, ".claude", "projects", "-proj");
  mkdirSync(claude, { recursive: true });
  const transcript = join(claude, "session.jsonl");
  const storePath = join(dir, "store", "events.ndjson");
  mkdirSync(join(dir, "store"), { recursive: true });
  const touch = (ageMs: number, now = NOW) => { writeFileSync(transcript, `${[message("user", now - ageMs - 1000), message("assistant", now - ageMs)].join("\n")}\n`); setMtime(transcript, now - ageMs); };
  const working = (now = NOW) => sessionsWorking({ roots: transcriptRoots(dir), now });
  const read = (now = NOW) => storeFreshness({ storePath, now, roots: transcriptRoots(dir) });
  return { dir, claude, transcript, storePath, touch, working, read };
}

/** The store's reading in a fresh home whose one turn is `storeAge` old and whose transcript was last written `touchAge` ago. */
function readingAfter(storeAge: number, touchAge: number) {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - storeAge)]);
  h.touch(touchAge);
  return h.read();
}

test("FRESH: the newest turn is 3 minutes old and a message was written 6 minutes ago -- not stale", () => {
  const reading = readingAfter(3 * MINUTE, 6 * MINUTE);
  assert.equal(reading.working, true, "POSITIVE CONTROL: a session is working, so this reading could have been stale");
  assert.equal(reading.ageMs, 3 * MINUTE);
  assert.deepEqual(reading.unmet, [], "the message is not yet ten minutes old, so the ingest is not owed a turn for it");
  assert.equal(reading.stale, false);
});

test("STALE: a message written 11 minutes ago is owed a turn, and the store has none for its transcript", () => {
  const reading = readingAfter(11 * MINUTE, 11 * MINUTE);
  assert.equal(reading.ageMs, 11 * MINUTE);
  assert.deepEqual(reading.unmet, [{ transcript: "session", at: NOW - 11 * MINUTE }]);
  assert.equal(reading.stale, true);
  assert.match(freshnessLine(reading), /STALE \(1 message owed a turn has none/);
});

test("HELD BACK: the 2026-10-11 timeline is NOT stale: a session that went quiet and spoke again has its messages inside the hold-back, which no turn exists for yet", () => {
  const h = home();
  const T = NOW; // the newest turn, answering the message written at T - 6 minutes
  writeStore(h.storePath, [turn("t1", T, "session")]);
  const at = T + 10 * MINUTE + 10 * 1000; // the check runs at T + 10m10s
  writeFileSync(h.transcript, `${[message("assistant", T - 6 * MINUTE), message("user", T + 6 * MINUTE), message("assistant", T + 9 * MINUTE + 50 * 1000)].join("\n")}\n`);
  setMtime(h.transcript, T + 9 * MINUTE + 50 * 1000);
  const reading = h.read(at);
  assert.equal(reading.ageMs, 10 * MINUTE + 10 * 1000, "the store is over ten minutes old");
  assert.equal(reading.working, false, "NEGATIVE CONTROL: both messages inside the window are younger than the hold-back, so the ingest is not owed a turn for either");
  assert.deepEqual(reading.unmet, [], "the one message past the ten-minute mark has its turn");
  assert.equal(reading.stale, false);
  assert.match(freshnessLine(reading), /no session is working.*not stale/);

  // POSITIVE CONTROL: the same timeline with no turn for the message at T - 6 minutes, which is owed one now.
  writeStore(h.storePath, [turn("t1", T)]);
  const stale = h.read(at);
  assert.deepEqual(stale.unmet, [{ transcript: "session", at: T - 6 * MINUTE }], "so the held-back case is not passing by the check going blind");
  assert.equal(stale.stale, true);
});

test("the edges: the hold-back decides what is working (a message exactly five minutes old is past it), and the ten-minute mark decides what is owed (exactly ten minutes is owed, a millisecond younger is not)", () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  writeFileSync(h.transcript, `${message("assistant", NOW - 5 * MINUTE + 1)}\n`);
  setMtime(h.transcript, NOW);
  assert.equal(h.working(), false, "a message one millisecond inside the hold-back is held back");
  writeFileSync(h.transcript, `${message("assistant", NOW - 5 * MINUTE)}\n`);
  setMtime(h.transcript, NOW);
  assert.equal(h.working(), true, "a message exactly five minutes old is past it");
  assert.equal(h.read().stale, false, "five minutes old is not yet owed");
  writeFileSync(h.transcript, `${message("assistant", NOW - STALE_AFTER_MS + 1)}\n`);
  setMtime(h.transcript, NOW);
  assert.equal(h.read().stale, false, "a millisecond inside the ten-minute mark is not owed yet");
  writeFileSync(h.transcript, `${message("assistant", NOW - STALE_AFTER_MS)}\n`);
  setMtime(h.transcript, NOW);
  assert.equal(h.read().stale, true, "exactly ten minutes old is owed a turn, and the store has none for it");
});

test("NEGATIVE CONTROL: an 11-minute-old store is NOT stale when every transcript has been untouched for an hour", () => {
  const reading = readingAfter(11 * MINUTE, 60 * MINUTE);
  assert.equal(reading.ageMs, 11 * MINUTE, "the store is as old as in the stale case: only the owed message differs");
  assert.equal(reading.working, false);
  assert.deepEqual(reading.unmet, []);
  assert.equal(reading.stale, false);
  assert.match(freshnessLine(reading), /no session is working.*not stale/);
});

test("the store's age is not a test of its own: an old store is stale only while a message is owed a turn it lacks, and a store with no turn at all is stale only then too", () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - 60 * MINUTE)]);
  h.touch(60 * MINUTE);
  assert.equal(h.read().stale, false, "an hour-old store with nothing owed");
  const absent = join(h.dir, "no-such.ndjson");
  h.touch(11 * MINUTE);
  const owed = storeFreshness({ storePath: absent, now: NOW, roots: transcriptRoots(h.dir) });
  assert.deepEqual([owed.newestTurnAt, owed.ageMs, owed.stale], [null, null, true]);
  h.touch(60 * MINUTE);
  assert.equal(storeFreshness({ storePath: absent, now: NOW, roots: transcriptRoots(h.dir) }).stale, false);
});

test("a TOUCHED transcript is not a message: mtime inside the window, newest message older than it, only bookkeeping lines after it (the shape of a11ign/a11ign#928's three false incidents)", () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  writeFileSync(h.transcript, `${[message("user", NOW - 40 * MINUTE), message("assistant", NOW - 30 * MINUTE), attachment(NOW - 29 * MINUTE), ...bookkeeping()].join("\n")}\n`);
  setMtime(h.transcript, NOW - MINUTE);
  assert.ok(NOW - statSync(h.transcript).mtimeMs < STALE_AFTER_MS, "the file's mtime is inside the window");
  assert.equal(h.working(), false, "NEGATIVE CONTROL: nothing was written inside the window");
  const reading = h.read();
  assert.equal(reading.stale, false, "an 11-minute-old store is not stale when no message of this transcript is owed a turn");
  assert.match(freshnessLine(reading), /no session is working/);

  // POSITIVE CONTROL: the same mtime, with one message 11 minutes old ahead of the same bookkeeping lines: owed, and read from its own line.
  writeFileSync(h.transcript, `${[message("user", NOW - 40 * MINUTE), message("assistant", NOW - 11 * MINUTE), ...bookkeeping()].join("\n")}\n`);
  setMtime(h.transcript, NOW - MINUTE);
  const stale = h.read();
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.unmet, [{ transcript: "session", at: NOW - 11 * MINUTE }]);
  assert.match(freshnessLine(stale), /STALE \(1 message owed a turn has none/);
  assert.doesNotMatch(freshnessLine(stale), /transcript changed/);

  // the working window's edge is the message's own time, and an attachment's timestamp is not a message's.
  writeFileSync(h.transcript, `${[message("assistant", NOW - STALE_AFTER_MS - 1), attachment(NOW - MINUTE)].join("\n")}\n`);
  setMtime(h.transcript, NOW);
  assert.equal(h.working(), false);
  writeFileSync(h.transcript, `${message("assistant", NOW - STALE_AFTER_MS)}\n`);
  setMtime(h.transcript, NOW);
  assert.equal(h.working(), true);
});

test("a transcript untouched for the window is not opened: a message line inside the window in a file whose mtime is older is not read", () => {
  const h = home();
  writeFileSync(h.transcript, `${message("assistant", NOW - MINUTE)}\n`);
  setMtime(h.transcript, NOW - 60 * MINUTE);
  assert.equal(h.working(), false, "the mtime is the filter in front of the read (a file not modified since before the window cannot hold a message in it)");
});

test("the message is found from the tail: past one huge line, in a file longer than the first window, and with a half-written last line", () => {
  const h = home();
  const big = JSON.stringify({ type: "user", timestamp: new Date(NOW - 60 * MINUTE).toISOString(), message: { content: "y".repeat(600_000) } });
  const lines = [message("user", NOW - 90 * MINUTE), message("assistant", NOW - 7 * MINUTE), big, ...bookkeeping()];
  writeFileSync(h.transcript, `${lines.join("\n")}\n`);
  setMtime(h.transcript, NOW);
  assert.ok(statSync(h.transcript).size > 512 * 1024, "POSITIVE CONTROL: the huge line is longer than the first tail window");
  assert.equal(newestMessageAt(h.transcript), NOW - 7 * MINUTE, "the first window ends inside the huge line and holds only bookkeeping, so the window grew to the message behind it");
  assert.equal(h.working(), true);
  appendFileSync(h.transcript, `${message("assistant", NOW - MINUTE)}\n{"type":"assistant","timestamp":"${new Date(NOW).toISOString()}","mess`); // a writer in the middle of a line
  assert.equal(newestMessageAt(h.transcript), NOW - MINUTE, "an unparseable last line is not a message");
  assert.equal(h.working(), true);
});

test("a Codex rollout counts by its `response_item` lines, and its `token_count` events are not messages", () => {
  const dir = tmpDir("freshness-codex-");
  const day = join(dir, ".codex", "sessions", "2026", "10", "10");
  mkdirSync(day, { recursive: true });
  mkdirSync(join(dir, ".claude", "projects"), { recursive: true });
  const rollout = join(day, "rollout-2026-10-10T11-00-00-01a1083e-a702-7921-b986-5102f84a4453.jsonl");
  const item = (type: string, payload: object, at: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
  const working = () => sessionsWorking({ roots: transcriptRoots(dir), now: NOW });
  writeFileSync(rollout, `${[item("response_item", { type: "message", role: "assistant" }, NOW - 30 * MINUTE), item("event_msg", { type: "token_count" }, NOW - MINUTE)].join("\n")}\n`);
  setMtime(rollout, NOW - MINUTE);
  assert.equal(working(), false, "NEGATIVE CONTROL: only a token_count event is inside the window");
  appendFileSync(rollout, `${item("response_item", { type: "function_call_output" }, NOW - 7 * MINUTE)}\n`);
  assert.equal(working(), true);
});

test("a transcript root that cannot be read throws: not knowing whether anyone works is never 'nobody works'", () => {
  const h = home();
  assert.throws(() => sessionsWorking({ roots: [{ dir: join(h.dir, "no-such-root"), depth: 1 }], now: NOW }));
  assert.equal(sessionsWorking({ roots: [{ dir: join(h.dir, "no-such-root"), depth: 1, optional: true }], now: NOW }), false);
});

test("the newest turn is read from the tail: newest by `at` and not by position, past a long run of other events, ignoring a line being written", () => {
  const h = home();
  const filler = Array.from({ length: 12000 }, (_, i) => other(`g${i}`, NOW - 90 * MINUTE + i)); // ~0.9 MiB of non-turn lines after the turn
  writeStore(h.storePath, [turn("old", NOW - 40 * MINUTE), turn("new", NOW - 5 * MINUTE), turn("earlier-but-later-on-the-file", NOW - 30 * MINUTE), ...filler]);
  appendFileSync(h.storePath, other("pad", NOW).padEnd(1_200_000, " ") + "\n");
  assert.ok(statSync(h.storePath).size > 1024 * 1024 + Buffer.byteLength(filler.join("\n")), "POSITIVE CONTROL: the newest turn is beyond the first 1 MiB window, so the window grew to find it");
  assert.equal(newestTurnAt(h.storePath), NOW - 5 * MINUTE);
  appendFileSync(h.storePath, `{"id":"half","kind":"turn","at":${NOW}`); // a writer in the middle of a line, no newline
  assert.equal(newestTurnAt(h.storePath), NOW - 5 * MINUTE, "an unparseable last line is not a turn");
});

const TWO_DAYS = 2 * 24 * 60 * MINUTE;
const FIRST_WINDOW = 1024 * 1024;
const oldTurns = (count: number, prefix = "old") => Array.from({ length: count }, (_, i) => turn(`${prefix}${i}`, NOW - TWO_DAYS + i)); // ~45 bytes a line

test("COLD START (a11ign/agent-org#709): a turn one minute old on the FIRST line and more than a window of two-day-old turns last is NOT stale, and the one-minute-old turn is returned", () => {
  const h = home();
  h.touch(6 * MINUTE);
  writeStore(h.storePath, [turn("fresh", NOW - MINUTE), ...oldTurns(30000)]);
  assert.ok(statSync(h.storePath).size > 1.2 * FIRST_WINDOW, "the cold-start shape: the old turns alone fill more than the first window");
  assert.equal(newestTurnAt(h.storePath, NOW), NOW - MINUTE);
  const reading = h.read();
  assert.deepEqual([reading.newestTurnAt, reading.ageMs, reading.working, reading.stale], [NOW - MINUTE, MINUTE, true, false]);
});

test("COLD START: a recent turn early, a run of non-turn lines over several windows, and an OLD turn last (the first tail window holds only the old turn) is read to the recent turn", () => {
  const h = home();
  const gh = Array.from({ length: 70000 }, (_, i) => other(`g${i}`, NOW - TWO_DAYS + i));
  writeStore(h.storePath, [turn("fresh", NOW - 3 * MINUTE), ...gh, turn("last-and-old", NOW - TWO_DAYS)]);
  assert.ok(statSync(h.storePath).size > 3 * FIRST_WINDOW, "the recent turn is beyond the first three windows");
  assert.equal(newestTurnAt(h.storePath, NOW), NOW - 3 * MINUTE);
});

test("COLD START: the window edge falls INSIDE the line that holds the recent turn, and a line spanning two chunks is read whole", () => {
  const h = home();
  const fresh = turn("fresh", NOW - MINUTE);
  const tail = turn("old", NOW - TWO_DAYS).padEnd(FIRST_WINDOW - 10 - 1, " "); // 10 bytes of the recent line's end, with its newline, fall inside the first window
  writeStore(h.storePath, [turn("before", NOW - TWO_DAYS - MINUTE), fresh, tail]);
  const edge = statSync(h.storePath).size - FIRST_WINDOW;
  const freshStarts = Buffer.byteLength(`${turn("before", NOW - TWO_DAYS - MINUTE)}\n`);
  assert.ok(edge > freshStarts && edge < freshStarts + Buffer.byteLength(fresh), "the first window begins in the middle of the recent turn's line");
  assert.equal(newestTurnAt(h.storePath, NOW), NOW - MINUTE);
});

test("POSITIVE CONTROL: a store whose every turn is two days old reads stale while a message is owed a turn, and returns the newest of them wherever on the file it is", () => {
  const h = home();
  h.touch(11 * MINUTE);
  writeStore(h.storePath, [turn("newest-of-old", NOW - TWO_DAYS + 60 * MINUTE), ...oldTurns(30000)]);
  assert.ok(statSync(h.storePath).size > 1.2 * FIRST_WINDOW);
  assert.equal(newestTurnAt(h.storePath, NOW), NOW - TWO_DAYS + 60 * MINUTE, "the whole file is read before an old reading is given as the answer");
  const reading = h.read();
  assert.deepEqual([reading.ageMs, reading.stale], [TWO_DAYS - 60 * MINUTE, true]);
  h.touch(60 * MINUTE);
  assert.equal(h.read().stale, false, "old with nothing owed is still not stale");
});

test("a store of more than a window with no `turn` at all still returns null, and is stale while a message is owed a turn", () => {
  const h = home();
  h.touch(11 * MINUTE);
  writeStore(h.storePath, Array.from({ length: 30000 }, (_, i) => other(`g${i}`, NOW - i)));
  assert.ok(statSync(h.storePath).size > 1.2 * FIRST_WINDOW);
  assert.equal(newestTurnAt(h.storePath, NOW), null);
  const reading = h.read();
  assert.deepEqual([reading.newestTurnAt, reading.ageMs, reading.stale], [null, null, true]);
  writeFileSync(h.storePath, "");
  assert.equal(newestTurnAt(h.storePath, NOW), null, "an empty store holds no turn");
});

test("readStore streams in chunks: lines spanning chunk edges, multibyte text, the last copy of an id, and an unterminated last line read as the whole read does", () => {
  const h = home();
  const lines = [
    JSON.stringify({ id: "a", kind: "turn", at: 1, note: "日本語 — café" }),
    JSON.stringify({ id: "b", kind: "turn", at: 2 }),
    JSON.stringify({ id: "a", kind: "turn", at: 3, note: "the later copy of a" }),
    "",
    JSON.stringify({ id: "c", kind: "gh_call", at: 4, note: "x".repeat(300) }),
  ];
  writeFileSync(h.storePath, `${lines.join("\n")}\n${JSON.stringify({ id: "d", kind: "turn", at: 5 })}`); // no trailing newline
  const whole = readStore(h.storePath);
  assert.deepEqual(whole.map((event) => event.id), ["b", "a", "c", "d"], "the last copy of an id wins, in the order the last copies sit");
  assert.equal((whole.find((event) => event.id === "a") as unknown as { note: string }).note, "the later copy of a");
  for (const chunkBytes of [1, 2, 3, 7, 64, 301]) assert.deepEqual(readStore(h.storePath, chunkBytes), whole, `chunk of ${chunkBytes} bytes`);
  assert.deepEqual(readStore(join(h.dir, "absent.ndjson")), []);
});

/** The effects as a recorder, each of which can be made to refuse. */
function recorder(refuse: { comment?: boolean; order?: boolean } = {}) {
  const sent: { comment: string[]; order: string[]; log: string[] } = { comment: [], order: [], log: [] };
  const effects: Effects = {
    comment: (body) => { if (refuse.comment) throw new Error("gh: HTTP 502"); sent.comment.push(body); },
    order: (text) => { if (refuse.order) throw new Error("prompt:session refused"); sent.order.push(text); },
    log: (line) => sent.log.push(line),
  };
  return { sent, effects, refuse };
}

test("the incident is raised ONCE over three consecutive stale checks, and again after a recovery", async () => {
  const h = home();
  const { sent, effects } = recorder();
  // each check finds one message 11 minutes old in the transcript, owed a turn: the store answers none of them until the recovery turn
  const check = (now: number) => { h.touch(11 * MINUTE, now); return checkAndRaise({ storePath: h.storePath, now, roots: transcriptRoots(h.dir), effects }); };
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  const first = await check(NOW);
  assert.deepEqual(first.raised, ["comment", "order"]);
  for (const at of [NOW + 5 * MINUTE, NOW + 10 * MINUTE]) await check(at);
  assert.equal(sent.comment.length, 1, "one comment on the standing row across three stale checks");
  assert.equal(sent.order.length, 1, "one order to the owning seat across the same three");
  assert.match(sent.comment[0], new RegExp(`class \`${INCIDENT_CLASS}\``));
  assert.match(sent.order[0], new RegExp(`^Class: ${INCIDENT_CLASS}\\n`), "the order's first line is the class prompt:session records it under");
  assert.ok(sent.order[0].includes(`#${INCIDENT_ROW}`));

  // RECOVERY: a turn for the transcript lands, the next check sees nothing owed unanswered and closes the episode.
  appendFileSync(h.storePath, `${turn("t2", NOW + 14 * MINUTE, "session")}\n`);
  const recovered = await check(NOW + 15 * MINUTE);
  assert.equal(recovered.episode.open, false);
  assert.deepEqual(recovered.raised, []);
  // ... and then it goes stale again: a second incident, once.
  for (const at of [NOW + 30 * MINUTE, NOW + 35 * MINUTE]) await check(at);
  assert.equal(sent.comment.length, 2, "a second comment, for the second episode");
  assert.equal(sent.order.length, 2, "a second order, for the second episode");
});

test("a quiet check (nothing owed) neither opens an episode nor ends the open one", async () => {
  const h = home();
  const { sent, effects } = recorder();
  const check = (now: number) => checkAndRaise({ storePath: h.storePath, now, roots: transcriptRoots(h.dir), effects });
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  h.touch(60 * MINUTE, NOW);
  assert.deepEqual((await check(NOW)).raised, [], "nothing owed, nothing raised");
  h.touch(11 * MINUTE, NOW + MINUTE);
  await check(NOW + MINUTE);
  h.touch(60 * MINUTE, NOW + 2 * MINUTE);
  await check(NOW + 2 * MINUTE); // a quiet stretch in the middle of the outage
  h.touch(11 * MINUTE, NOW + 3 * MINUTE);
  await check(NOW + 3 * MINUTE);
  assert.deepEqual([sent.comment.length, sent.order.length], [1, 1], "one episode across the quiet check");
});

test("a refused effect is tried again next run and the one that landed is not sent twice", async () => {
  const h = home();
  const { sent, effects, refuse } = recorder({ comment: true });
  const check = (now: number) => { h.touch(11 * MINUTE, now); return checkAndRaise({ storePath: h.storePath, now, roots: transcriptRoots(h.dir), effects }); };
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  const first = await check(NOW);
  assert.deepEqual(first.raised, ["order"], "the order landed although the comment was refused");
  assert.ok(sent.log.some((line) => /comment on #928 was refused/.test(line)));
  refuse.comment = false;
  const second = await check(NOW + 5 * MINUTE);
  assert.deepEqual(second.raised, ["comment"]);
  await check(NOW + 10 * MINUTE);
  assert.deepEqual([sent.comment.length, sent.order.length], [1, 1]);
});

/** One run of the unit with a clock that the ingest moves: `INGEST_TOOK` passes between the clock's one reading and the check, as a real ingest's seconds do. The ingest is a stand-in: the hold-back itself is `store.ts`'s and is tested there. */
const INGEST_TOOK = 20 * 1000;
async function runUnit(h: ReturnType<typeof home>, messageAgeAtIngestStart: number) {
  let clock = NOW;
  let reads = 0;
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]); // the newest turn is old: only the message below can make this stale
  writeFileSync(h.transcript, `${message("assistant", NOW - messageAgeAtIngestStart)}\n`);
  setMtime(h.transcript, NOW - messageAgeAtIngestStart);
  const { sent, effects } = recorder();
  const ran = await ingestThenCheck({
    storePath: h.storePath, roots: transcriptRoots(h.dir), effects,
    clock: () => { reads += 1; return clock; },
    ingest: () => { clock += INGEST_TOOK; return "ingested"; },
  });
  return { ...ran, sent, reads, checkedAt: clock };
}

test("a11ign/agent-org#1091: a message 9:59 old when the ingest STARTED is not owed; the ingest moved the clock past ten minutes, so a reading taken after it would have owed one, and this one does not", async () => {
  const h = home();
  const messageAt = NOW - 9 * MINUTE - 59 * 1000;
  const ran = await runUnit(h, 9 * MINUTE + 59 * 1000);
  assert.equal(ran.checkedAt - NOW, INGEST_TOOK, "POSITIVE CONTROL: the ingest moved the clock, so a clock read after it would see the message past the ten-minute mark");
  assert.ok(ran.checkedAt - messageAt >= OWED_AFTER_MS, "a reading after the ingest would have owed it (10:19 old)");
  assert.equal(ran.reads, 1, "the clock is read once, before the ingest");
  assert.equal(ran.ingested, "ingested", "the ingest's own result is handed back for the exit code");
  assert.equal(ran.reading.working, true, "past the hold-back at the ingest's start: a working session");
  assert.deepEqual(ran.reading.unmet, [], "but not owed a turn at the start, so there is nothing to be stale for");
  assert.equal(ran.reading.stale, false);
  assert.deepEqual(ran.raised, []);
  assert.deepEqual(ran.sent.comment, [], "no incident is posted for a message the ingest was not yet owed");
  assert.ok(!existsSync(episodeFileFor(h.storePath)) || JSON.parse(readFileSync(episodeFileFor(h.storePath), "utf8")).open === false, "no open episode was written for it");
});

test("a11ign/agent-org#1091 POSITIVE CONTROL: a message 10:02 old when the ingest started was owed a turn and has none, so the same run reads STALE", async () => {
  const h = home();
  const ran = await runUnit(h, 10 * MINUTE + 2 * 1000);
  assert.deepEqual(ran.reading.unmet, [{ transcript: "session", at: NOW - 10 * MINUTE - 2 * 1000 }]);
  assert.equal(ran.reading.stale, true, "the check is not made blind to make the held-back case pass");
  assert.deepEqual(ran.raised, ["comment", "order"]);
  assert.match(incidentComment(ran.reading, NOW), /STALE/);
});

test("the episode is written before the effects, so a run killed in them raises again and does not lose the incident", async () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  h.touch(11 * MINUTE);
  const killed: Effects = { comment: () => { throw new Error("killed"); }, order: () => { throw new Error("killed"); }, log: () => {} };
  await checkAndRaise({ storePath: h.storePath, now: NOW, roots: transcriptRoots(h.dir), effects: killed });
  const held = JSON.parse(readFileSync(episodeFileFor(h.storePath), "utf8"));
  assert.deepEqual([held.open, held.commented, held.ordered], [true, false, false]);
});

test("advance is pure: a stale store opens once, a current store with a turn inside the window closes, and a quiet one changes nothing", () => {
  const owed = [{ transcript: "session", at: NOW - 11 * MINUTE }];
  const stale = { newestTurnAt: NOW - 11 * MINUTE, ageMs: 11 * MINUTE, working: true, unmet: owed, stale: true };
  const opened = advance(NO_EPISODE, stale, NOW);
  assert.deepEqual(opened, { open: true, since: NOW, commented: false, ordered: false });
  assert.equal(advance(opened, stale, NOW + MINUTE), opened, "an open episode is returned as it is");
  assert.equal(advance(opened, { ...stale, working: false, unmet: [], stale: false }, NOW + MINUTE), opened, "old and not owed changes nothing");
  assert.equal(advance(opened, { newestTurnAt: NOW, ageMs: MINUTE, working: true, unmet: [], stale: false }, NOW + MINUTE), NO_EPISODE);
  assert.deepEqual(advance(NO_EPISODE, { newestTurnAt: NOW, ageMs: MINUTE, working: true, unmet: owed, stale: true }, NOW), { open: true, since: NOW, commented: false, ordered: false }, "a stale store with a fresh turn is still stale");
  assert.equal(advance(NO_EPISODE, { newestTurnAt: NOW - 11 * MINUTE, ageMs: 11 * MINUTE, working: false, unmet: [], stale: false }, NOW), NO_EPISODE);
  assert.ok(incidentOrder(stale, NOW).startsWith(`Class: ${INCIDENT_CLASS}\n`));
});

// ---- the CLI: `trace -- --ingest` and `trace -- --freshness`, run as the unit runs them, against a scratch HOME and a fixture host declaration.
const TRACE = fileURLToPath(new URL("./trace.ts", import.meta.url));
const SCRATCH = mkdtempSync(join(tmpdir(), "freshness-cli-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("../packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT },],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
/** A `gh` that records that it was called and fails: a mode that "calls no GitHub" leaves the record absent. */
const GH_BIN = join(SCRATCH, "fake-bin");
const GH_CALLS = join(SCRATCH, "gh-calls.log");
mkdirSync(GH_BIN);
writeFileSync(join(GH_BIN, "gh"), `#!/bin/sh\necho "$@" >> ${GH_CALLS}\nexit 1\n`, { mode: 0o755 });

const wakeRecord = (timestamp: string, session: string) => JSON.stringify({ type: "user", timestamp, message: { role: "user", content: `\n\n<pasted_content id="1">\nYou are \`${session}\` -- row 9001 has been claimed for you.\n</pasted_content>` } });
const blockRecord = (timestamp: string, id: string) => JSON.stringify({ type: "assistant", timestamp, requestId: `req_${id}`, message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "x" }],
  usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 6448, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } } } });

/** A scratch HOME for the CLI: a wake ledger, one transcript of one turn, and the places a run would write. */
function cliHome() {
  const dir = mkdtempSync(join(SCRATCH, "home-"));
  mkdirSync(join(dir, ".cache", "a11ign"), { recursive: true });
  writeFileSync(join(dir, ".cache", "a11ign", "wake-ledger"), "");
  mkdirSync(join(dir, ".claude", "projects", "-proj"), { recursive: true });
  const transcript = join(dir, ".claude", "projects", "-proj", "worker.jsonl");
  writeFileSync(transcript, `${[wakeRecord("2026-10-04T10:00:00.000Z", "worker-9001"), blockRecord("2026-10-04T10:00:04.000Z", "msg_w")].join("\n")}\n`);
  const storePath = join(dir, "events.ndjson");
  const run = (...flags: string[]) => spawnSync(process.execPath, [TRACE, "--", ...flags, "--store", storePath], {
    encoding: "utf8", cwd: PROJECT, env: { PATH: `${GH_BIN}:/usr/bin:/bin`, HOME: dir, AGENT_ORG_HOST: HOST_FILE },
  });
  return { dir, transcript, storePath, run };
}

test("`--ingest` adds the turn, a second run adds nothing, it prints one report line and the duplicate-id line, renders nothing and calls no GitHub", () => {
  const h = cliHome();
  const first = h.run("--ingest", "--since", "2026-10-01T00:00:00Z");
  assert.equal(first.status, 0, first.stderr);
  const lines = first.stdout.trim().split("\n");
  assert.deepEqual(lines.filter((line) => !/^ {2}COLD START: /.test(line)).length, 2, `one report line, the duplicate-id line (and, on a first run, the cold-start note) and no rendering: ${first.stdout}`);
  assert.match(lines[0], /^ingest: 1 transcripts read, 0 unchanged, \d+ events added, 0 failed/);
  assert.equal(lines.at(-1), "duplicate ids: 0 (0 extra lines)", "agent-org#476: the store's duplicate count is on the report, and zero is said");
  const turns = () => readStore(h.storePath).filter((event) => event.kind === "turn");
  assert.equal(turns().length, 1, "the transcript's turn is in the store");
  const stored = readFileSync(h.storePath, "utf8");
  const second = h.run("--ingest", "--since", "2026-10-01T00:00:00Z");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^ingest: 0 transcripts read, 1 unchanged, 0 events added, 0 failed/);
  assert.equal(readFileSync(h.storePath, "utf8"), stored, "the store is byte-identical after the second run");
  assert.equal(existsSync(GH_CALLS), false, "no `gh` was called");
});

test("`--ingest` prints `duplicate ids: n` and exits 1 above zero, as it does for an unreadable source, and still adds what it read (agent-org#476)", () => {
  const h = cliHome();
  const since = ["--since", "2026-10-01T00:00:00Z"];
  writeFileSync(h.storePath, `${JSON.stringify({ id: "old", kind: "wake" })}\n${JSON.stringify({ id: "old", kind: "wake", n: 2 })}\n`);
  const run = h.run("--ingest", ...since);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /^duplicate ids: 1 \(1 extra lines\)$/m);
  assert.match(run.stdout, /^ingest: 1 transcripts read/, "the transcript was still read: the failure is the count, not a refusal to ingest");
  assert.equal(readStore(h.storePath).filter((event) => event.kind === "turn").length, 1);
  const control = cliHome().run("--ingest", ...since);
  assert.equal(control.status, 0, `CONTROL: a store with each id once exits 0: ${control.stderr}`);
});

test("`--ingest` counts and exits on a failure of ANY source: an unreadable `gh` ledger or deferral log is `1 failed` and exit 1, and an absent one is not a failure", () => {
  const since = ["--since", "2026-10-01T00:00:00Z"];
  const clean = cliHome();
  const control = clean.run("--ingest", ...since);
  assert.equal(control.status, 0, `CONTROL: no ledger and no deferral log is a host that has had none, not a failure: ${control.stderr}`);
  assert.match(control.stdout, /^ingest: 1 transcripts read, 0 unchanged, \d+ events added, 0 failed/);

  // A path that exists and cannot be read as a file (a directory) fails the file: listed, state unmoved, never skipped.
  const unreadable = [
    { source: "gh call ledger", path: (dir: string) => join(dir, "workers", "gh", "gh-calls.tsv") },
    { source: "deferral log", path: (dir: string) => join(dir, ".cache", "a11ign", DEFERRAL_LOG_FILE) },
  ];
  for (const { source, path } of unreadable) {
    const h = cliHome();
    mkdirSync(path(h.dir), { recursive: true });
    const ran = h.run("--ingest", ...since);
    assert.match(ran.stdout, /^ingest: 1 transcripts read, 0 unchanged, \d+ events added, 1 failed/, `${source}: the failure is counted\n${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, new RegExp(`^ {2}failed: ${path(h.dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), `${source}: and named`);
    assert.equal(ran.status, 1, `${source}: and the exit code says so, so a unit over it shows FAILED`);
  }
});

test("`--freshness` exits 1 for a stale store and 0 for a fresh one, and 0 for an old store nobody is owed a turn for", () => {
  const h = cliHome();
  const now = Date.now();
  const touch = (ageMs: number) => { writeFileSync(h.transcript, `${message("assistant", now - ageMs)}\n`); setMtime(h.transcript, now - ageMs); };
  // One run, for a store whose one turn is `storeAge` old and a transcript last written `touchAge` ago.
  const freshnessRun = (storeAge: number, touchAge: number) => { writeStore(h.storePath, [turn("t1", now - storeAge)]); touch(touchAge); return h.run("--freshness"); };
  const fresh = freshnessRun(3 * MINUTE, 2 * MINUTE);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout, /not stale/);

  // owed a turn, which the store does not have: the message is past the ten-minute mark
  const stale = freshnessRun(11 * MINUTE, 11 * MINUTE);
  assert.equal(stale.status, 1, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /STALE/);

  touch(60 * MINUTE);
  const quiet = h.run("--freshness");
  assert.equal(quiet.status, 0, "NEGATIVE CONTROL: the same 11-minute-old store, every transcript untouched for an hour");
  assert.match(quiet.stdout, /no session is working/);
  assert.equal(existsSync(GH_CALLS), false, "no `gh` was called");
});

// --- the incident's comment goes through the code host (A11-160, step 8) ---------------------------------------------------------------

afterEach(() => forgetActivation());

test("the incident's comment is the code host's: it lands on the standing record row of the home tracker, and a refusal is said with the row it was for", async () => {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  const repo = homeProjectDeclaration().tracker[0].repo;
  world.repo = repo;
  world.rows.set(Number(INCIDENT_ROW), fakeRow(world, Number(INCIDENT_ROW), { title: "the standing record" }));
  substituteCodeHost(host);
  const told: string[] = [];
  await hostEffects((line) => told.push(line)).comment("the store has stopped");
  assert.deepEqual(world.rows.get(Number(INCIDENT_ROW))!.comments.map((comment) => comment.body), ["the store has stopped"]);
  assert.deepEqual(world.reports.trace.inputComments, [{ repo, number: INCIDENT_ROW, body: "the store has stopped" }]);

  world.failures.set("commentOnRowByInput", new Error("HTTP 502: Bad Gateway"));
  await assert.rejects(async () => hostEffects((line) => told.push(line)).comment("again"), new RegExp(`comment on ${repo.replace("/", "\\/")}#${INCIDENT_ROW}: HTTP 502: Bad Gateway`));
  assert.equal(world.rows.get(Number(INCIDENT_ROW))!.comments.length, 1, "a refused comment is not on the row: the effect is not recorded as landed");
});
