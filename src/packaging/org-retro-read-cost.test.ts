// no-token: gh -- no `gh` or file outside a temp directory is touched; the pull requests, the acceptance file and the clock are fixtures (a11ign/agent-org#1081)
// #1081: the daily retrospective's reads walk the merged pull requests only above a per-repository mark, and cache the acceptance files by merge commit, in the state entry.
//
// THE POSITIVE CONTROL is the first tick (no state entry): every merged list is read in full, the acceptance file is read once, and the memory is written.
// THE NEGATIVE CONTROL is the second tick over the SAME fixture: one page per merged list (the top page, which the mark stops), and zero acceptance reads.
// Removing the cache lookup in `acceptanceOf` turns the negative control red: the second tick then reads the acceptance file again.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { freshRetroReads, readInertOptions, readMergedRowOpen } from "../org-retro/retro-cause.ts";
import { keepRetroReads, readRetroReads, resetRetroTally, retroReadsLine, RETRO_READS_FILE } from "../org-retro.ts";
import { connectionOf, readsRowsByLabel, readsRowsSince, sinceAnswer, type FakeRow } from "./rows-by-label-fixtures.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
const TRACKER = "o/tracker";
const CODE = "o/code";
const SHA = "a".repeat(40);
const ACCEPTANCE = ".acceptance/the-thing.md";
const DECLARATION: any = { tracker: [{ key: "", repo: TRACKER }], code: [{ key: "", repo: CODE }] };
const NAMING_KEY = `${CODE}|number body headRefName`;
const INERT_KEY = `${CODE}|number body mergeCommit{oid} files(first:100){nodes{path}}`;

/** A merged pull request of `CODE` that closes row 4001 of the tracker, merged `minutes` ago; `updated` is its last update (the walk's clock), newer after an edit. */
const merged = (number: number, { minutes = 60, body = `Closes ${TRACKER}#4001`, updated = minutes }: { minutes?: number; body?: string; updated?: number; } = {}) => ({
  number, body, headRefName: "agent/the-thing-4001", mergedAt: ago(minutes), updatedAt: ago(updated), mergeCommit: { oid: SHA }, files: [{ path: ACCEPTANCE }],
});

/** A `gh` for the tick: the merged pull requests answered newest-updated first, as the connection orders them; every other list empty. It counts the pages it serves and the lists it is asked. */
function forge(merged: FakeRow[]) {
  const pages: { select: string; after: string | null; }[] = [];
  let lists = 0;
  const read = (args: string[]): any[] | null => {
    const since = readsRowsSince(args);
    if (since !== null) {
      pages.push({ select: since.kind, after: since.after });
      return JSON.parse(sinceAnswer(args, [...merged].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))));
    }
    if (readsRowsByLabel(args) !== null) return JSON.parse(connectionOf([]));
    lists += 1;
    return [];
  };
  return { read, pages, lists: () => lists };
}

/** The acceptance file's text, counted: every call is an acceptance read the memory did not answer. */
function acceptanceReads() {
  const reads: string[] = [];
  const readAcceptance = ({ repo, path, oid }: { repo: string; path: string; oid: unknown; }) => {
    reads.push(`${repo}|${path}|${String(oid)}`);
    return "option: on\n";
  };
  return { readAcceptance, reads };
}

/** One tick's reads, as `dailyRetrospective` makes them: the naming read and the idle read's merged list (the second is in the same tick), then the inert read. */
function tick(dir: string, gh: ReturnType<typeof forge>, acceptance: ReturnType<typeof acceptanceReads>) {
  const memory = readRetroReads(dir);
  resetRetroTally();
  const rows = readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: gh.read, memory });
  const again = readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: gh.read, memory });
  const inert = readInertOptions({ now: NOW, declaration: DECLARATION, read: gh.read, readFile: () => "", readAcceptance: acceptance.readAcceptance, recorded: [], memory });
  keepRetroReads(dir, memory);
  return { memory, rows, again, inert };
}

test("the first tick reads every merged list in full, reads each acceptance file once, and writes the mark and the cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "org-retro-reads-"));
  try {
    const gh = forge([merged(7), merged(8, { minutes: 90 })]);
    const acceptance = acceptanceReads();
    const { memory, rows, again, inert } = tick(dir, gh, acceptance);

    assert.equal(memory.unreadable, true, "no state entry: the tick says so");
    assert.deepEqual(memory.fullReads, [CODE, CODE], "each merged list is read in full, and named");
    assert.deepEqual(gh.pages.map((page) => page.after), [null, null], "one page of each merged list, the first page of a full read");
    assert.deepEqual(acceptance.reads, [`${CODE}|${ACCEPTANCE}|${SHA}`], "one acceptance read for the one merged file, at its merge commit");
    assert.deepEqual(again, rows, "the second read in the tick answers from the mark");
    assert.notEqual(inert, null);

    const kept = JSON.parse(readFileSync(join(dir, RETRO_READS_FILE), "utf8"));
    assert.deepEqual(Object.keys(kept.marks).sort(), [INERT_KEY, NAMING_KEY].sort());
    assert.equal(kept.marks[NAMING_KEY].updatedAt, ago(60), "the mark is the newest update the walk saw");
    assert.deepEqual(kept.contents, { [`${CODE}|${ACCEPTANCE}|${SHA}`]: "option: on\n" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the second tick over the same fixture reads one page per merged list and no acceptance file, and reaches the same readings", () => {
  const dir = mkdtempSync(join(tmpdir(), "org-retro-reads-"));
  try {
    const fixture = [merged(7), merged(8, { minutes: 90 })];
    const first = forge(fixture);
    const firstAcceptance = acceptanceReads();
    const one = tick(dir, first, firstAcceptance);

    const second = forge(fixture);
    const secondAcceptance = acceptanceReads();
    const two = tick(dir, second, secondAcceptance);

    assert.equal(two.memory.unreadable, false, "the state entry is read");
    assert.deepEqual(two.memory.fullReads, [], "no mark is missing, so nothing is read in full");
    assert.deepEqual(secondAcceptance.reads, [], "zero acceptance contents reads");
    assert.deepEqual(second.pages.map((page) => page.after), [null, null], "one top page per merged list: the mark stops the walk there");
    assert.deepEqual(two.rows, one.rows, "same naming readings");
    assert.deepEqual(two.inert, one.inert, "same inert readings");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a merged pull request whose body was edited after its merge replaces its old copy in the mark", () => {
  const dir = mkdtempSync(join(tmpdir(), "org-retro-reads-"));
  try {
    tick(dir, forge([merged(7), merged(8, { minutes: 90 })]), acceptanceReads());

    const edited = forge([merged(7, { body: `Closes ${TRACKER}#4002`, updated: 5 }), merged(8, { minutes: 90 })]);
    tick(dir, edited, acceptanceReads());

    const kept = JSON.parse(readFileSync(join(dir, RETRO_READS_FILE), "utf8"));
    const rows = kept.marks[NAMING_KEY].rows as { number: number; body: string; }[];
    assert.deepEqual(rows.map((row) => [row.number, row.body]).sort(), [[7, `Closes ${TRACKER}#4002`], [8, `Closes ${TRACKER}#4001`]], "one row per number, the edited body kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unreadable state entry is read in full and named in the line", () => {
  const dir = mkdtempSync(join(tmpdir(), "org-retro-reads-"));
  try {
    writeFileSync(join(dir, RETRO_READS_FILE), "{not json");
    const memory = readRetroReads(dir);
    assert.equal(memory.unreadable, true);
    const gh = forge([merged(7)]);
    readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: gh.read, memory });
    assert.deepEqual(memory.fullReads, [CODE]);
    assert.match(retroReadsLine(memory), /; the state entry is missing or unreadable, so the merged lists and acceptance contents are read in full; read in full, the mark missing or unreadable: o\/code$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the RETRO READS line names the three classes with a count and seconds each, and the notes the memory earns", () => {
  resetRetroTally();
  assert.match(retroReadsLine(freshRetroReads()), /^RETRO READS: pages 0 in 0\.0 s, lists 0 in 0\.0 s, acceptance contents 0 in 0\.0 s$/);
  const full = freshRetroReads();
  full.fullReads.push(CODE, CODE);
  assert.equal(retroReadsLine(full), "RETRO READS: pages 0 in 0.0 s, lists 0 in 0.0 s, acceptance contents 0 in 0.0 s; read in full, the mark missing or unreadable: o/code");
});
