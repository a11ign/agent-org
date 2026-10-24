// no-token: gh -- the code host is the fake (the open rows are its world's, and the arguments of the pull request reads are its stand-in lines), every `run` is a recorder that answers from a table, so the real `gh` is never reached; the memory, the tick's scopes and the due-index are files in this run's private TMPDIR
/**
 * #1093: IN `webhook` MODE THE GATE READS ONLY THE PULL REQUESTS ITS SCOPES NAME, `poll` MODE IS WHAT IT WAS, AND A DATED WAIT'S INSTANT REACHES THE DUE-INDEX.
 *
 * POSITIVE CONTROL: a webhook tick whose scopes name one remembered pull request makes exactly one `pr view` and no `pr list`, and patches that one in.
 * NEGATIVE CONTROL: the same inputs with no scopes file (`poll`), or for another repository, make the whole read's calls and write nothing. A scoped
 * path that fired there would change the calls, and this is the test that says so.
 *
 * `run` is a recorder, so each test shows the CALLS the read made as well as the list it returned (named `list <page size>` and `view <number>`: the arguments themselves are the code host's, and the fake's are stand-in lines; what the
 * plugin sends is asserted in `plugins/github/rows/gate-pull-reads.test.ts` and `pull-view-args-wire.test.ts`). The open ROWS are the fake code host's world. Each test names the mutation that turns it red.
 */
import { test, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUE_INDEX_ENTRY as GATE_DUE_INDEX_ENTRY, readOpenRows } from "../work-gate/reads.ts";
import { MAX_UNCHANGED_SECONDS, OPEN_ROWS_LIMIT, defaultRun, isAmbientRun, isGhRun, readPrs, readWithFirstWaveTogether, standingFor } from "../work-gate/reads/read-memo-and-exit.ts";
import { readPrList, writePrList, type PrEntry } from "../pr-list-memory.ts";
import { writeTickScopes } from "../tick-scopes.ts";
import { dueRepos, readDueIndex, writeDueIndex, type DueEntry } from "../due-index.ts";
import { dueEntriesOf, recordDueInstants } from "../work-gate/due-index-write.ts";
import { DUE_INDEX_ENTRY, TICK_SCOPES_VARIABLE } from "../work-tick.ts";
import { REPO } from "../project-identity.ts";
import { BACKLOG_LABEL } from "../project-vocabulary.ts";
import { AGED_BACKLOG_MS } from "../work-gate/causes/rows-backlog.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

const OTHER = "a11ign/a11y-witness";
const NOW = 2_000_000_000;
const READ_AT = NOW - 60_000;
const MAX_AGE_MS = MAX_UNCHANGED_SECONDS * 1000;

const made: string[] = [];
const dir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "work-gate-scopes-"));
  made.push(path);
  return path;
};
after(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

let host = createFakeCodeHost();
beforeEach(() => {
  host = createFakeCodeHost();
  substituteCodeHost(host);
});
afterEach(() => forgetActivation());

/** The calls a recorder was given, named by what they ask: the open list at a page size, or one pull request. */
const named = (calls: string[][]): string[] => calls.map(([verb, first]) => (verb === "fake-open-pull-list" ? `list ${first}` : verb === "fake-pull-view" ? `view ${first}` : verb));

/** A pull request as `pr list --json` shapes one: no `state`, and no paged files (`changedFiles` 0 is a complete list). */
const pr = (number: number, extra: Record<string, unknown> = {}): PrEntry => ({
  number, isDraft: false, headRefOid: `sha${number}`, title: `PR ${number}`, files: [], changedFiles: 0, ...extra,
});

/** A recorder: the open list answers `list`, the view of pull request N answers `views[N]`, and anything else is a failure the test would see. The arguments are the code host's (the fake's are stand-in lines). */
function recorder({ list, views }: { list: PrEntry[]; views: Record<number, unknown>; }) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "fake-open-pull-list") return JSON.stringify(list);
    if (args[0] === "fake-pull-view") {
      if (!(Number(args[1]) in views)) throw new Error(`no view for #${args[1]}`);
      return JSON.stringify(views[Number(args[1])]);
    }
    throw new Error(`unexpected call ${args.join(" ")}`);
  };
  return { run, calls };
}

const seeded = (root: string, prs: PrEntry[], readAtMs = READ_AT) => {
  const memoryPath = join(root, "open-prs.json");
  writePrList({ path: memoryPath, repo: REPO, prs, readAtMs });
  return memoryPath;
};

const scopesFile = (root: string, scopes: Parameters<typeof writeTickScopes>[0]["scopes"]) => {
  const path = join(root, "tick-scopes.json");
  writeTickScopes({ path, scopes });
  return path;
};

const scopedRead = (scope: Parameters<typeof writeTickScopes>[0]["scopes"][number]) => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7)]);
  const tickScopesPath = scopesFile(root, [scope]);
  return { ...recorder({ list: [pr(7)], views: {} }), memoryPath, tickScopesPath };
};

test("POSITIVE CONTROL: a webhook tick naming one remembered pull request views that one and lists nothing", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7), pr(5)]);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]);
  const { run, calls } = recorder({ list: [], views: { 5: { ...pr(5, { title: "moved" }), state: "OPEN" } } });
  const prs = readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  // Mutation: readPrs ignores the scopes and reads whole -> a `pr list` call appears here and the test is red.
  assert.deepEqual(named(calls), ["view 5"]);
  assert.deepEqual(prs?.map((entry) => [entry.number, entry.title]), [[7, "PR 7"], [5, "moved"]]);
});

test("a pull request that closed or merged leaves the remembered list", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7), pr(5)]);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]);
  const { run } = recorder({ list: [], views: { 5: { ...pr(5), state: "MERGED" } } });
  const prs = readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  // Mutation: a merged entry kept in the list -> [7, 5] and the test is red.
  assert.deepEqual(prs?.map((entry) => entry.number), [7]);
});

test("a pull request opened since the list was read joins it", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7)]);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 9 }]);
  const { run } = recorder({ list: [], views: { 9: { ...pr(9), state: "OPEN" } } });
  const prs = readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  // Mutation: only entries already in the memory are patched -> [7] and the test is red.
  assert.deepEqual(prs?.map((entry) => entry.number), [9, 7]);
});

test("a tick with no remembered list reads whole, and remembers what it read", () => {
  const root = dir();
  const memoryPath = join(root, "open-prs.json");
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 3 }]);
  const { run, calls } = recorder({ list: [pr(3)], views: {} });
  const prs = readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  assert.deepEqual(named(calls), ["list 20"]);
  assert.deepEqual(prs?.map((entry) => entry.number), [3]);
  // Mutation: the whole read is not remembered -> the next tick finds nothing and reads whole again; this read is then "missing" and the test is red.
  const memory = readPrList({ path: memoryPath, repo: REPO, nowMs: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(memory.ok, true);
  assert.equal(memory.ok && memory.readAtMs, NOW);
});

test("a remembered list older than the reconcile is read whole", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7)], NOW - MAX_AGE_MS - 1);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 7 }]);
  const { run, calls } = recorder({ list: [pr(7), pr(4)], views: {} });
  const prs = readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  // Mutation: the age is not checked -> the single `pr view` appears and the test is red.
  assert.deepEqual(named(calls).map((call) => call.split(" ")[0]), ["list"]);
  assert.deepEqual(prs?.map((entry) => entry.number), [7, 4]);
});

/** What `readPrs` wrote to stderr while it ran. */
function stderrOf(read: () => unknown): string {
  const write = process.stderr.write;
  let said = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { said += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    read();
  } finally {
    process.stderr.write = write;
  }
  return said;
}

test("a repository with no open pull requests says nothing about reading whole: an empty list is never remembered, so its old entry ages for as long as it stays empty", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7)], NOW - MAX_AGE_MS - 1);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 7 }]);
  const empty = recorder({ list: [], views: {} });
  const said = stderrOf(() => readPrs(empty.run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW }));
  // Mutation: the line is written before the read, as it was -> it repeats each tick for the whole empty stretch (60 ticks on 2026-10-13) and the test is red.
  assert.equal(said, "");
  // POSITIVE CONTROL: the same stale memory with a list that is not empty still says why it read whole.
  const full = recorder({ list: [pr(7)], views: {} });
  const spoke = stderrOf(() => readPrs(full.run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW }));
  assert.match(spoke, /the open list is read whole \(too-old: /);
});

test("a commit scope names no remembered pull request, so the list is read whole", () => {
  const { run, calls, memoryPath, tickScopesPath } = scopedRead({ repo: REPO, kind: "sha", sha: "deadbeef" });
  readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  // Mutation: a sha scope is treated as nothing to read -> no `pr list`, and the test is red.
  assert.deepEqual(named(calls).map((call) => call.split(" ")[0]), ["list"]);
});

test("a view that fails reads the whole list, never the half-patched memory", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7)]);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]);
  const { run, calls } = recorder({ list: [pr(5), pr(7)], views: {} });
  const prs = readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  // Mutation: a failed view answers the memory unpatched -> [7] and no second call, and the test is red.
  assert.deepEqual(named(calls).map((call) => call.split(" ")[0]), ["view", "list"]);
  assert.deepEqual(prs?.map((entry) => entry.number), [5, 7]);
});

test("NEGATIVE CONTROL: poll mode (no scopes file) reads whole exactly as before, and writes no memory", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7)]);
  scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]);
  const { run, calls } = recorder({ list: [pr(8)], views: { 5: { ...pr(5), state: "OPEN" } } });
  const prs = readPrs(run, null, { home: true, memoryPath, nowMs: NOW });
  // Mutation: the scoped path runs without a scopes file -> a `pr view` appears here and the test is red.
  assert.deepEqual(named(calls), ["list 20"]);
  assert.deepEqual(prs?.map((entry) => entry.number), [8]);
  // Mutation: poll mode remembers its list -> readAtMs moves to NOW and the test is red.
  const memory = readPrList({ path: memoryPath, repo: REPO, nowMs: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(memory.ok && memory.readAtMs, READ_AT);
});

test("NEGATIVE CONTROL: another repository's read stays whole even when a scopes file names pull requests", () => {
  const { run, calls, memoryPath, tickScopesPath } = scopedRead({ repo: REPO, kind: "pr", number: 7 });
  readPrs(run, null, { home: false, tickScopesPath, memoryPath, nowMs: NOW });
  // Mutation: the home check is dropped -> the memory answers with no call and the test is red.
  assert.deepEqual(named(calls).map((call) => call.split(" ")[0]), ["list"]);
});

test("the tick's variable is read from the environment, under the name the tick hands it", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7), pr(5)]);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]);
  const before = process.env[TICK_SCOPES_VARIABLE];
  process.env[TICK_SCOPES_VARIABLE] = tickScopesPath;
  try {
    const { run, calls } = recorder({ list: [], views: { 5: { ...pr(5), state: "OPEN" } } });
    readPrs(run, null, { home: true, memoryPath, nowMs: NOW });
    // Mutation: the gate reads a different variable name than `work-tick.ts` hands it -> a whole `pr list` appears here and the test is red.
    assert.deepEqual(named(calls), ["view 5"]);
  } finally {
    if (before === undefined) delete process.env[TICK_SCOPES_VARIABLE];
    else process.env[TICK_SCOPES_VARIABLE] = before;
  }
});

test("the due-index file is the one the tick reads", () => {
  // Mutation: the gate writes its due-index under another name -> the tick never sees a dated wait come due and the test is red.
  assert.equal(DUE_INDEX_ENTRY, "due-index.json");
});

test("a dated wait's instant reaches the due-index and comes due at that instant", () => {
  const root = dir();
  const path = join(root, "due-index.json");
  const rows = [
    { number: 11, body: "Not-before: 2026-10-12T16:00:00Z", labels: [], createdAt: "2026-10-01T00:00:00Z" },
    { number: 12, body: "Fleet-hold-until: 2026-10-13T08:00:00Z", labels: [], createdAt: "2026-10-01T00:00:00Z" },
    { number: 13, body: "", labels: [{ name: BACKLOG_LABEL }], createdAt: "2026-10-10T00:00:00Z" },
    { number: 14, body: "no date here", labels: [], createdAt: "2026-10-10T00:00:00Z" },
  ];
  const agedAt = Date.parse("2026-10-10T00:00:00Z") + AGED_BACKLOG_MS + 1;
  const entries: DueEntry[] = [
    { number: 11, dueAtMs: Date.parse("2026-10-12T16:00:00Z"), kind: "not-before" },
    { number: 12, dueAtMs: Date.parse("2026-10-13T08:00:00Z"), kind: "fleet-hold-until" },
    { number: 13, dueAtMs: agedAt, kind: "aged-backlog" },
  ];
  assert.deepEqual(dueEntriesOf(rows), entries);
  recordDueInstants({ path, repo: REPO, rows });
  const read = readDueIndex(path);
  assert.equal(read.status, "ok");
  assert.deepEqual(read.index[REPO], entries);
  // Mutation: the aged backlog instant drops its one millisecond -> the row is due at the boundary itself, not one ms after, and this is red.
  assert.deepEqual(dueRepos({ index: read.index, afterMs: null, nowMs: Date.parse("2026-10-11T00:00:00Z") }), []);
  assert.deepEqual(dueRepos({ index: read.index, afterMs: null, nowMs: Date.parse("2026-10-12T16:00:00Z") }), [REPO]);
  // An instant the previous tick already looked at is not due again.
  assert.deepEqual(dueRepos({ index: read.index, afterMs: Date.parse("2026-10-12T16:00:00Z"), nowMs: Date.parse("2026-10-12T16:30:00Z") }), []);
});

test("writing one repository's due instants keeps the others' and drops its own when it has none", () => {
  const root = dir();
  const path = join(root, "due-index.json");
  writeDueIndex({ path, repo: OTHER, entries: [{ number: 2, dueAtMs: 5, kind: "not-before" }] });
  recordDueInstants({ path, repo: REPO, rows: [{ number: 11, body: "Not-before: 2026-10-12T16:00:00Z", labels: [], createdAt: "2026-10-01T00:00:00Z" }] });
  assert.deepEqual(Object.keys(readDueIndex(path).index ?? {}).sort(), [OTHER, REPO].sort());
  recordDueInstants({ path, repo: REPO, rows: [] });
  // Mutation: an empty write keeps the repository's old entries -> REPO is still listed and the test is red.
  assert.deepEqual(Object.keys(readDueIndex(path).index ?? {}), [OTHER]);
});

test("a scope list of [] serves the remembered list as it is, with no call", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7), pr(5)]);
  const tickScopesPath = scopesFile(root, []);
  const { run, calls } = recorder({ list: [], views: {} });
  const got = readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  // Mutation: an empty scope list is read as "unknown" -> a whole `pr list` is asked for and both assertions are red.
  assert.deepEqual(calls, []);
  assert.deepEqual(got?.map((each: any) => each.number).sort(), [5, 7]);
});

test("a refused read is null, never an empty list, on the whole path and after a failed view", () => {
  const root = dir();
  const refuse = (): string => { throw new Error("HTTP 403: rate limit"); };
  // no remembered list: the whole read is asked for and refused
  assert.equal(readPrs(refuse, null, { home: true, tickScopesPath: scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]), memoryPath: join(root, "none.json"), nowMs: NOW }), null);
  // a remembered list, a view that is refused, and the whole read refused too
  const memoryPath = seeded(root, [pr(5)]);
  // Mutation: a refused whole read after a failed view returns the remembered list -> a stale list is served as a reading and this is red.
  assert.equal(readPrs(refuse, null, { home: true, tickScopesPath: scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]), memoryPath, nowMs: NOW }), null);
});

test("the code host holds the view the narrowed read asks for, and the gate spawns none of its own", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(12), pr(5)]);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 12 }]);
  const { run, calls } = recorder({ list: [], views: { 12: { ...pr(12), state: "OPEN" } } });
  readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  // pull request 12 is read and no other, and the call is the port's: the view of 12 with the open list's fields and `state` (the arguments themselves are asserted in `plugins/github/rows/pull-view-args-wire.test.ts`).
  assert.deepEqual(named(calls), ["view 12"]);
  assert.match(calls[0]![2]!, /,state$/);
});

/** A refusal: the open rows are the code host's, so the `run` the gate hands the read is never used. */
const noRun = (args: string[]): string => { throw new Error(`the fake code host acts on its own state: no gh is run for ${args.join(" ")}`); };
type SeededRow = { number: number; title: string; labels: string[]; body: string; createdAt: string };
/** Opens `rows` in the world the active code host holds. */
const open = (rows: SeededRow[]): void => {
  for (const row of rows) host.rowsWorld.rows.set(row.number, { ...row, state: "OPEN", closedAt: null, comments: [], blockedBy: [], onBoard: false, boardStatus: null });
};
const DATED: SeededRow[] = [{ number: 11, title: "t", labels: [], body: "Not-before: 2026-10-12T16:00:00Z", createdAt: "2026-10-01T00:00:00Z" }];

test("the due-index file the gate names is the one the tick reads", () => {
  // Mutation: the gate's copy of the name drifts from `work-tick.ts` -> the tick reads an index nothing writes and this is red.
  assert.equal(GATE_DUE_INDEX_ENTRY, DUE_INDEX_ENTRY);
});

test("POSITIVE CONTROL: in webhook mode the open rows the gate reads reach the due-index, and the tick's dueRepos reads them back", () => {
  const root = dir();
  const dueIndexPath = join(root, "due-index.json");
  open(DATED);
  const rows = readOpenRows(noRun, null, { webhook: true, dueIndexPath });
  assert.equal(rows?.length, 1);
  const read = readDueIndex(dueIndexPath);
  assert.equal(read.status, "ok");
  const at = Date.parse("2026-10-12T16:00:00Z");
  // Mutation: readOpenRows never records -> the index is missing, `read.index[REPO]` is undefined and this is red.
  assert.deepEqual(read.index[REPO], [{ number: 11, dueAtMs: at, kind: "not-before" }]);
  // one instant passed after the previous tick, one is still ahead
  assert.deepEqual(dueRepos({ index: read.index, afterMs: at - 1000, nowMs: at + 1000 }), [REPO]);
  assert.deepEqual(dueRepos({ index: read.index, afterMs: at - 2000, nowMs: at - 1000 }), []);
});

test("NEGATIVE CONTROL: poll mode makes the same call, returns the same rows and writes no index", () => {
  const root = dir();
  const dueIndexPath = join(root, "due-index.json");
  // Mutation: the write ignores the mode -> the file exists and this is red.
  open(DATED);
  assert.deepEqual(readOpenRows(noRun, null, { webhook: false, dueIndexPath })?.map(({ number, body }) => ({ number, body })), DATED.map(({ number, body }) => ({ number, body })));
  assert.equal(readDueIndex(dueIndexPath).status, "missing");
});

test("a list at the row cap may be cut, so it records nothing and keeps what an earlier pass wrote", () => {
  const root = dir();
  const dueIndexPath = join(root, "due-index.json");
  writeDueIndex({ path: dueIndexPath, repo: REPO, entries: [{ number: 9, dueAtMs: 7, kind: "not-before" }] });
  open(Array.from({ length: OPEN_ROWS_LIMIT }, (_, index) => ({ number: index + 1, title: "t", labels: [], body: "", createdAt: "2026-10-01T00:00:00Z" })));
  // Mutation: the cap check is dropped -> the cut list replaces the entries with none and this is red.
  assert.equal(readOpenRows(noRun, null, { webhook: true, dueIndexPath })?.length, OPEN_ROWS_LIMIT);
  assert.deepEqual(readDueIndex(dueIndexPath).index?.[REPO], [{ number: 9, dueAtMs: 7, kind: "not-before" }]);
});

test("a due-index that cannot be written is said and the rows are still returned", () => {
  const root = dir();
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((text: string) => { said.push(String(text)); return true; }) as typeof process.stderr.write;
  try {
    // a parent that is a file: the directory cannot be made, and nothing is left beside the path
    writeFileSync(join(root, "blocker"), "");
    open(DATED);
    const rows = readOpenRows(noRun, null, { webhook: true, dueIndexPath: join(root, "blocker", "due-index.json") });
    assert.equal(rows?.length, 1);
  } finally {
    process.stderr.write = write;
  }
  assert.match(said.join(""), /the due instants could not be recorded/);
});

test("the gate's own reads are ambient, and a lane aimed at another repository is not, so only the checkout's repository is narrowed or recorded", () => {
  // Mutation: the first wave's wrappers are not marked ambient -> the production path (`readTrackerLanes` reads through them) never narrows or records, and this is red.
  const seen: ((args: string[], repo?: string) => string)[] = [];
  readWithFirstWaveTogether((read) => { seen.push(read); return null; }, defaultRun, (calls) => calls.map(() => ({ stdout: "[]" })));
  assert.equal(seen.length, 2, "the rehearsal and the real pass");
  assert.deepEqual(seen.map(isAmbientRun), [true, true]);
  assert.equal(isAmbientRun(defaultRun), true);
  // an aimed lane stands for `gh` (`standingFor`, as `readLanes` makes it) but is not ambient; a test's `run` is neither
  const aimed = standingFor(defaultRun, (args: string[]) => defaultRun(args, "other/repo"));
  assert.equal(isGhRun(aimed), true);
  assert.equal(isAmbientRun(aimed), false);
  assert.equal(isAmbientRun(() => "[]"), false);
});

test("NEGATIVE CONTROL: an empty list of rows (the first wave's rehearsal answer) records nothing and keeps what an earlier pass wrote", () => {
  const root = dir();
  const dueIndexPath = join(root, "due-index.json");
  writeDueIndex({ path: dueIndexPath, repo: REPO, entries: [{ number: 9, dueAtMs: 7, kind: "not-before" }] });
  // Mutation: the emptiness check is dropped -> the stand-in `[]` replaces the entries with none and this is red.
  assert.deepEqual(readOpenRows(noRun, null, { webhook: true, dueIndexPath }), []);
  assert.deepEqual(readDueIndex(dueIndexPath).index?.[REPO], [{ number: 9, dueAtMs: 7, kind: "not-before" }]);
});

test("NEGATIVE CONTROL: an empty whole list is never remembered, so a stand-in `[]` cannot be served as the repository's list", () => {
  const root = dir();
  const memoryPath = join(root, "open-prs.json");
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]);
  const { run } = recorder({ list: [], views: {} });
  // Mutation: the emptiness check is dropped -> the memory holds `[]` for the repository and this is red.
  assert.deepEqual(readPrs(run, null, { home: true, tickScopesPath, memoryPath, nowMs: NOW }), []);
  const memory = readPrList({ path: memoryPath, repo: REPO, nowMs: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(memory.ok, false);
});

test("the narrowed path never consults the conditional reader, and the whole path hands it the read as before", () => {
  const root = dir();
  const memoryPath = seeded(root, [pr(7), pr(5)]);
  const tickScopesPath = scopesFile(root, [{ repo: REPO, kind: "pr", number: 5 }]);
  const asked: string[] = [];
  const conditional = { ask: (path: string) => { asked.push(path); throw new Error("no REST read on the narrowed path"); }, dir: root, now: NOW, repo: REPO };
  const { run, calls } = recorder({ list: [pr(8)], views: { 5: { ...pr(5), state: "OPEN" } } });
  const narrowed = readPrs(run, conditional, { home: true, tickScopesPath, memoryPath, nowMs: NOW });
  assert.deepEqual(narrowed?.map((entry) => entry.number), [7, 5].sort((a, b) => b - a));
  assert.deepEqual(asked, []);
  assert.deepEqual(named(calls), ["view 5"]);
  // no memory: whole, and the conditional reader is asked (its failure falls back to the listing it always made)
  const stale = join(root, "none.json");
  const whole = recorder({ list: [pr(8)], views: {} });
  assert.deepEqual(readPrs(whole.run, conditional, { home: true, tickScopesPath, memoryPath: stale, nowMs: NOW })?.map((entry) => entry.number), [8]);
  assert.notDeepEqual(asked, []);
});
