// a11ign/agent-org#498: the trace store's own clock and the signal that it has stopped. Fixtures only: a scratch home (transcripts, wake ledger, store), a fixture host declaration, and a
// `gh` that records a call and fails, so "calls no GitHub" is a measured absence. Nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- the CLI cases run with a PATH whose `gh` is a recorder that exits 1; the incident's own `gh` is injected as a recording effect
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { DEFERRAL_LOG_FILE } from "../deferral-log.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import {
  advance, checkAndRaise, episodeFileFor, freshnessLine, INCIDENT_CLASS, INCIDENT_ROW, incidentOrder, NO_EPISODE, newestTurnAt, sessionsWorking, STALE_AFTER_MS, storeFreshness, transcriptRoots,
} from "./freshness.ts";
import type { Effects } from "./freshness.ts";
import { readStore } from "./store.ts";

const MINUTE = 60 * 1000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const turn = (id: string, at: number) => JSON.stringify({ id, kind: "turn", at });
const other = (id: string, at: number) => JSON.stringify({ id, kind: "gh_call", at });
const writeStore = (path: string, lines: string[]) => writeFileSync(path, `${lines.join("\n")}\n`);

/** A scratch home with one transcript, its mtime set, and a store beside the cache directory the tool names. */
function home() {
  const dir = tmpDir("freshness-");
  const claude = join(dir, ".claude", "projects", "-proj");
  mkdirSync(claude, { recursive: true });
  const transcript = join(claude, "session.jsonl");
  const storePath = join(dir, "store", "events.ndjson");
  mkdirSync(join(dir, "store"), { recursive: true });
  const touch = (ageMs: number, now = NOW) => { writeFileSync(transcript, "{}\n"); utimesSync(transcript, new Date(now - ageMs), new Date(now - ageMs)); };
  return { dir, transcript, storePath, touch, working: (now = NOW) => sessionsWorking({ roots: transcriptRoots(dir), now }) };
}

test("FRESH: the newest turn is 3 minutes old and a transcript changed 2 minutes ago -- not stale", () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - 3 * MINUTE)]);
  h.touch(2 * MINUTE);
  const reading = storeFreshness({ storePath: h.storePath, now: NOW, working: h.working() });
  assert.equal(reading.working, true, "POSITIVE CONTROL: somebody is working, so the store's age is the only thing keeping this from being stale");
  assert.equal(reading.ageMs, 3 * MINUTE);
  assert.equal(reading.stale, false);
});

test("STALE: the newest turn is 11 minutes old and a transcript changed 2 minutes ago", () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  h.touch(2 * MINUTE);
  const reading = storeFreshness({ storePath: h.storePath, now: NOW, working: h.working() });
  assert.equal(reading.ageMs, 11 * MINUTE);
  assert.equal(reading.stale, true);
  assert.match(freshnessLine(reading), /STALE/);
});

test("NEGATIVE CONTROL: an 11-minute-old store is NOT stale when every transcript has been untouched for an hour", () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  h.touch(60 * MINUTE);
  const reading = storeFreshness({ storePath: h.storePath, now: NOW, working: h.working() });
  assert.equal(reading.ageMs, 11 * MINUTE, "the store is just as old as in the stale case: only the working signal differs");
  assert.equal(reading.working, false);
  assert.equal(reading.stale, false);
  assert.match(freshnessLine(reading), /no session is working.*not stale/);
});

test("the boundary is the chairman's ten minutes, and a store with no turn at all is stale while anyone works", () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - STALE_AFTER_MS)]);
  assert.equal(storeFreshness({ storePath: h.storePath, now: NOW, working: true }).stale, false, "exactly ten minutes is not past ten minutes");
  writeStore(h.storePath, [turn("t1", NOW - STALE_AFTER_MS - 1)]);
  assert.equal(storeFreshness({ storePath: h.storePath, now: NOW, working: true }).stale, true);
  const absent = storeFreshness({ storePath: join(h.dir, "no-such.ndjson"), now: NOW, working: true });
  assert.deepEqual([absent.newestTurnAt, absent.ageMs, absent.stale], [null, null, true]);
  assert.equal(storeFreshness({ storePath: join(h.dir, "no-such.ndjson"), now: NOW, working: false }).stale, false);
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
  const check = (now: number, working = true) => checkAndRaise({ storePath: h.storePath, now, working, effects });
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  const first = await check(NOW);
  assert.deepEqual(first.raised, ["comment", "order"]);
  await check(NOW + 5 * MINUTE);
  await check(NOW + 10 * MINUTE);
  assert.equal(sent.comment.length, 1, "one comment on the standing row across three stale checks");
  assert.equal(sent.order.length, 1, "one order to the owning seat across the same three");
  assert.match(sent.comment[0], new RegExp(`class \`${INCIDENT_CLASS}\``));
  assert.match(sent.order[0], new RegExp(`^Class: ${INCIDENT_CLASS}\\n`), "the order's first line is the class prompt:session records it under");
  assert.ok(sent.order[0].includes(`#${INCIDENT_ROW}`));

  // RECOVERY: a turn lands, the next check sees the store fresh and closes the episode.
  appendFileSync(h.storePath, `${turn("t2", NOW + 14 * MINUTE)}\n`);
  const recovered = await check(NOW + 15 * MINUTE);
  assert.equal(recovered.episode.open, false);
  assert.deepEqual(recovered.raised, []);
  // ... and then it goes stale again: a second incident, once.
  await check(NOW + 30 * MINUTE);
  await check(NOW + 35 * MINUTE);
  assert.equal(sent.comment.length, 2, "a second comment, for the second episode");
  assert.equal(sent.order.length, 2, "a second order, for the second episode");
});

test("a quiet check (old store, nobody working) neither opens an episode nor ends the open one", async () => {
  const h = home();
  const { sent, effects } = recorder();
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  assert.deepEqual((await checkAndRaise({ storePath: h.storePath, now: NOW, working: false, effects })).raised, [], "nobody working, nothing raised");
  await checkAndRaise({ storePath: h.storePath, now: NOW + MINUTE, working: true, effects });
  await checkAndRaise({ storePath: h.storePath, now: NOW + 2 * MINUTE, working: false, effects }); // a quiet hour in the middle of the outage
  await checkAndRaise({ storePath: h.storePath, now: NOW + 3 * MINUTE, working: true, effects });
  assert.deepEqual([sent.comment.length, sent.order.length], [1, 1], "one episode across the quiet check");
});

test("a refused effect is tried again next run and the one that landed is not sent twice", async () => {
  const h = home();
  const { sent, effects, refuse } = recorder({ comment: true });
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  const first = await checkAndRaise({ storePath: h.storePath, now: NOW, working: true, effects });
  assert.deepEqual(first.raised, ["order"], "the order landed although the comment was refused");
  assert.ok(sent.log.some((line) => /comment on #928 was refused/.test(line)));
  refuse.comment = false;
  const second = await checkAndRaise({ storePath: h.storePath, now: NOW + 5 * MINUTE, working: true, effects });
  assert.deepEqual(second.raised, ["comment"]);
  await checkAndRaise({ storePath: h.storePath, now: NOW + 10 * MINUTE, working: true, effects });
  assert.deepEqual([sent.comment.length, sent.order.length], [1, 1]);
});

test("the episode is written before the effects, so a run killed in them raises again and does not lose the incident", async () => {
  const h = home();
  writeStore(h.storePath, [turn("t1", NOW - 11 * MINUTE)]);
  const killed: Effects = { comment: () => { throw new Error("killed"); }, order: () => { throw new Error("killed"); }, log: () => {} };
  await checkAndRaise({ storePath: h.storePath, now: NOW, working: true, effects: killed });
  const held = JSON.parse(readFileSync(episodeFileFor(h.storePath), "utf8"));
  assert.deepEqual([held.open, held.commented, held.ordered], [true, false, false]);
});

test("advance is pure: a turn inside the window closes, old-and-idle changes nothing, old-and-working opens once", () => {
  const stale = { newestTurnAt: NOW - 11 * MINUTE, ageMs: 11 * MINUTE, working: true, stale: true };
  const opened = advance(NO_EPISODE, stale, NOW);
  assert.deepEqual(opened, { open: true, since: NOW, commented: false, ordered: false });
  assert.equal(advance(opened, stale, NOW + MINUTE), opened, "an open episode is returned as it is");
  assert.equal(advance(opened, { ...stale, working: false, stale: false }, NOW + MINUTE), opened);
  assert.equal(advance(opened, { newestTurnAt: NOW, ageMs: MINUTE, working: true, stale: false }, NOW + MINUTE), NO_EPISODE);
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

test("`--ingest` adds the turn, a second run adds nothing, it prints one report line, renders nothing and calls no GitHub", () => {
  const h = cliHome();
  const first = h.run("--ingest", "--since", "2026-10-01T00:00:00Z");
  assert.equal(first.status, 0, first.stderr);
  const lines = first.stdout.trim().split("\n");
  assert.deepEqual(lines.filter((line) => !/^ {2}COLD START: /.test(line)).length, 1, `one report line (and, on a first run, the cold-start note) and no rendering: ${first.stdout}`);
  assert.match(lines[0], /^ingest: 1 transcripts read, 0 unchanged, \d+ events added, 0 failed/);
  const turns = () => readStore(h.storePath).filter((event) => event.kind === "turn");
  assert.equal(turns().length, 1, "the transcript's turn is in the store");
  const stored = readFileSync(h.storePath, "utf8");
  const second = h.run("--ingest", "--since", "2026-10-01T00:00:00Z");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^ingest: 0 transcripts read, 1 unchanged, 0 events added, 0 failed/);
  assert.equal(readFileSync(h.storePath, "utf8"), stored, "the store is byte-identical after the second run");
  assert.equal(existsSync(GH_CALLS), false, "no `gh` was called");
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

test("`--freshness` exits 1 for a stale store and 0 for a fresh one, and 0 for an old store nobody is working on", () => {
  const h = cliHome();
  const now = Date.now();
  const touch = (ageMs: number) => utimesSync(h.transcript, new Date(now - ageMs), new Date(now - ageMs));
  writeStore(h.storePath, [turn("t1", now - 3 * MINUTE)]);
  touch(2 * MINUTE);
  const fresh = h.run("--freshness");
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout, /not stale/);

  writeStore(h.storePath, [turn("t1", now - 11 * MINUTE)]);
  const stale = h.run("--freshness");
  assert.equal(stale.status, 1, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /STALE/);

  touch(60 * MINUTE);
  const quiet = h.run("--freshness");
  assert.equal(quiet.status, 0, "NEGATIVE CONTROL: the same 11-minute-old store, every transcript untouched for an hour");
  assert.match(quiet.stdout, /no session is working/);
  assert.equal(existsSync(GH_CALLS), false, "no `gh` was called");
});
