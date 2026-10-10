// agent-org#476: a sum over the trace store's raw lines is wrong twice over (an id on more than one line, and a stored `costUsd` that is the price of the day it was ingested), so no module
// reads the lines itself, the duplicates are counted, and the one command that sums is `trace cost`. Fixtures only: scratch stores and scratch source trees. Nothing here reads
// `~/.cache/a11ign`, GitHub or a transcript.
// no-token: none -- no test here calls `gh`; the CLI cases run `trace.ts duplicates` and `trace.ts cost` against a scratch store
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { costBy, costOf, duplicateIds, PRICES, repriceEvents } from "../trace/store.ts";
import type { TraceEvent } from "../trace/store.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENV_HOST = "AGENT_ORG_HOST";
const MILLION = 1_000_000;

/** What `trace.ts` refuses to import without: a declared project, which the caller's own wins over (`trace-store-compact.test.ts` does the same). */
function hostEnv(dir: string): NodeJS.ProcessEnv {
  if (process.env[ENV_HOST]) return process.env;
  const project = join(dir, "project");
  cpSync(join(ROOT, "src/packaging/fixtures/org-health/project"), project, { recursive: true });
  const hostFile = join(dir, "host.json");
  writeFileSync(hostFile, JSON.stringify({ schema: 1, home: dir, binDir: join(dir, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: project }],
    gh: { workers: join(dir, "workers"), leads: join(dir, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
  return { ...process.env, [ENV_HOST]: hostFile };
}

/** `node src/trace/trace.ts <word> ...`, as the host runs it. */
function trace(dir: string, ...args: string[]) {
  const run = spawnSync(process.execPath, ["src/trace/trace.ts", ...args], { cwd: ROOT, env: hostEnv(dir), encoding: "utf8" });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

const turn = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "turn", source: "transcript", at: Date.UTC(2026, 9, 10, 12), session: "worker-9001", row: 9001, pr: null, repo: null, cause: "ready-row-unclaimed", causeKey: null, wakeId: null, ...extra,
}) as unknown as TraceEvent;
const write = (path: string, events: TraceEvent[]) => writeFileSync(path, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
const scratch = (prefix: string) => {
  const dir = tmpDir(prefix);
  return { dir, store: join(dir, "events.ndjson") };
};

// ---- duplicateIds, and `trace.ts duplicates` ----

test("an id on three lines is the one duplicate, with 2 extra lines, and `trace.ts duplicates` exits 1 naming it", () => {
  const { dir, store } = scratch("trace-readers-dup-");
  write(store, [turn("a"), turn("b"), turn("a", { n: 2 }), turn("c"), turn("a", { n: 3 })]);
  const found = duplicateIds(store);
  assert.deepEqual([...found.ids], [["a", 3]]);
  assert.equal(found.extra, 2);
  assert.deepEqual([found.lines, found.distinct], [5, 3]);
  const run = trace(dir, "duplicates", "--store", store);
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /^duplicate ids: 1 \(2 extra lines\)$/m);
  assert.match(run.out, /^ {2}a: 3 lines$/m);
});

test("negative control: a store with every id once has no duplicates, and `trace.ts duplicates` exits 0", () => {
  const { dir, store } = scratch("trace-readers-once-");
  write(store, [turn("a"), turn("b"), turn("c")]);
  const found = duplicateIds(store);
  assert.deepEqual([found.ids.size, found.extra, found.lines], [0, 0, 3]);
  const run = trace(dir, "duplicates", "--store", store);
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /^duplicate ids: 0 \(0 extra lines\)$/m);
});

test("the count does not depend on how the line is written: another key first, an escaped id, a line spanning two chunks, an unfinished last line and a missing file", () => {
  const { dir, store } = scratch("trace-readers-shapes-");
  const lines = [
    JSON.stringify({ kind: "turn", id: "reordered" }), JSON.stringify({ kind: "turn", id: "reordered" }),
    JSON.stringify({ id: 'quote"d', kind: "turn" }), JSON.stringify({ id: 'quote"d', kind: "wake" }),
    JSON.stringify({ id: "long", pad: "x".repeat(300) }), JSON.stringify({ id: "long", pad: "y".repeat(300) }),
    JSON.stringify({ id: "single" }),
  ];
  writeFileSync(store, `${lines.join("\n")}\n{"id":"single","half`);
  const found = duplicateIds(store, 64);
  assert.deepEqual([...found.ids].sort(), [["long", 2], ["quote\"d", 2], ["reordered", 2]]);
  assert.equal(found.lines, 7, "the line a writer is still writing is not counted");
  assert.equal(duplicateIds(join(dir, "none.ndjson")).ids.size, 0, "a missing store holds none");
});

// ---- trace cost ----

const SONNET = "claude-sonnet-5-5";
const TOKENS = { input: 1000, output: 100, cacheRead: 3 * MILLION, cacheWrite5m: 0, cacheWrite1h: 20_000 };
/** The price of `TOKENS` worked from the `PRICES` row by hand, so the expectation is not `costOf` agreeing with itself. */
const sonnet = PRICES.find((price) => price.prefix === SONNET) as (typeof PRICES)[number];
const BY_HAND = (TOKENS.input * sonnet.input + TOKENS.output * sonnet.output + TOKENS.cacheRead * sonnet.cacheRead + TOKENS.cacheWrite1h * sonnet.input * 2) / MILLION;
const STORED_WRONG = 99; // what a stale first reading would sum

/** Columns of the row of `key` in the printed table. */
const rowOf = (out: string, key: string) => (out.split("\n").find((line) => line.startsWith(key)) ?? "").trim().split(/\s{2,}/);

test("`cost --by day` counts a turn that is on three lines once and prices it from PRICES, not from the stored costUsd", () => {
  const { dir, store } = scratch("trace-readers-cost-");
  const one = turn("t1", { model: SONNET, tokens: TOKENS, costUsd: STORED_WRONG });
  write(store, [one, turn("t2", { model: SONNET, tokens: { ...TOKENS, cacheRead: 0 }, costUsd: STORED_WRONG, at: Date.UTC(2026, 9, 11, 1) }), one, one]);
  const run = trace(dir, "cost", "--by", "day", "--store", store);
  assert.equal(run.status, 0, run.err);
  assert.match(run.out.split("\n")[0], /read through readStore, repriced from PRICES/, "the first line names how the sum was read");
  const [key, turns, unpriced, usd] = rowOf(run.out, "2026-10-10");
  assert.deepEqual([key, turns, unpriced], ["2026-10-10", "1", "0"], "the turn once, not three times");
  assert.equal(Number(usd), Math.round(BY_HAND * 10_000) / 10_000, "priced from PRICES");
  assert.notEqual(Number(usd), STORED_WRONG * 3, "CONTROL: the raw sum of the file is not what is printed");
  assert.equal(rowOf(run.out, "2026-10-11")[1], "1", "a second day is a second row");
  assert.deepEqual(rowOf(run.out, "total").slice(0, 3), ["total", "2", "0"]);
  // The same file summed the way a script would, which is the number the command exists to replace.
  const raw = readFileSync(store, "utf8").split("\n").filter(Boolean).reduce((sum, line) => sum + JSON.parse(line).costUsd, 0);
  assert.equal(raw, STORED_WRONG * 4, "positive control: the raw sum is four stored values, and it is not the answer");
});

test("`cost --by day` prints a second column with the cache reads at $0.20, and the two differ by exactly the cache-read tokens times $0.10 per million", () => {
  const { dir, store } = scratch("trace-readers-cost-20-");
  write(store, [turn("t1", { model: SONNET, tokens: TOKENS }), turn("t2", { model: SONNET, tokens: { ...TOKENS, cacheRead: 1_500_000 }, at: Date.UTC(2026, 9, 10, 13) })]);
  const run = trace(dir, "cost", "--by", "day", "--store", store);
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /usd \(cache reads at \$0\.20\/M\)/, "the column is labelled with its rate");
  const [, turns, , primary, atClient] = rowOf(run.out, "2026-10-10");
  assert.equal(turns, "2");
  const cacheRead = TOKENS.cacheRead + 1_500_000;
  const gap = (cacheRead * (0.2 - sonnet.cacheRead)) / MILLION;
  assert.equal(sonnet.cacheRead, 0.1, "the fixture's model is the one whose primary rate is $0.10");
  assert.equal(Math.round((Number(atClient) - Number(primary)) * 10_000), Math.round(gap * 10_000), `the columns differ by ${gap}`);
  assert.equal(Math.round(gap * 10_000), 4500, "4,500,000 cache-read tokens x $0.10 per million is $0.45");
  assert.ok(run.out.split("\n")[0].includes("PRICES"), "the first line still names the primary");
});

test("`cost` groups by row, cause and session, counts an unpriced model without dollaring it, honours --since, and refuses a missing or unknown --by", () => {
  const { dir, store } = scratch("trace-readers-cost-by-");
  write(store, [
    turn("a", { model: SONNET, tokens: TOKENS }), turn("b", { model: SONNET, tokens: TOKENS, row: 9002, session: "worker-9002", cause: "blocker-cleared" }),
    turn("c", { model: "some-model-with-no-price", tokens: TOKENS, row: null, rows: [9001, 9002] }),
    turn("old", { model: SONNET, tokens: TOKENS, at: Date.UTC(2026, 8, 1) }),
  ]);
  const since = "2026-10-01T00:00:00Z";
  const byRow = trace(dir, "cost", "--by", "row", "--since", since, "--store", store).out;
  assert.deepEqual(rowOf(byRow, "#9001").slice(0, 3), ["#9001", "2", "1"], "the unpriced turn on several rows is under each, counted and not dollared");
  assert.deepEqual(rowOf(byRow, "#9002").slice(0, 3), ["#9002", "2", "1"]);
  assert.deepEqual(rowOf(byRow, "total").slice(0, 3), ["total", "3", "1"], "the total counts the several-row turn once, and the pre-since turn not at all");
  assert.deepEqual(rowOf(trace(dir, "cost", "--by", "session", "--since", since, "--store", store).out, "worker-9002").slice(0, 2), ["worker-9002", "1"]);
  assert.deepEqual(rowOf(trace(dir, "cost", "--by", "cause", "--since", since, "--store", store).out, "blocker-cleared").slice(0, 2), ["blocker-cleared", "1"]);
  assert.equal(trace(dir, "cost", "--store", store).status, 1, "no --by");
  assert.equal(trace(dir, "cost", "--by", "week", "--store", store).status, 1, "an unknown --by");
});

test("costBy reads a turn once priced from its tokens and the repricing of the store agrees with it", () => {
  const events = [turn("t1", { model: SONNET, tokens: TOKENS, costUsd: STORED_WRONG })];
  assert.equal(costBy(events, "day").total.usd, costOf(SONNET, TOKENS));
  assert.equal(repriceEvents(events)[0].costUsd, costOf(SONNET, TOKENS));
  assert.equal(costBy(events, "day").total.usd, Math.round(BY_HAND * 1e8) / 1e8);
});

// ---- the source scan: nothing under src/ reads the store file's lines itself ----

/** Where a module may read the store's lines itself, and why. A reader not named here goes through `readStore`, `openStore` or `duplicateIds`, which keep the last copy of each id. */
const ALLOWED: Record<string, string> = {
  "src/trace/otel-receiver.ts": "`loadSeenIds`, the receiver's id scan: it reads the ids of the `source: otel` lines it already appended so it does not append one twice; it sums nothing",
  "src/trace/freshness.ts": "`newestTurnAt`: the tail of the file, for the newest turn's `at`; a maximum, so an id twice and a stored `costUsd` change nothing, and the whole file is 500 MB every five minutes",
};

/** The module that IS the reads (`readStore`, `openStore`, `duplicateIds`, the rewrite): left out of the walk here, in code, so it is not an entry in the list a reader of this file would argue with. */
const OWNER = "src/trace/store.ts";

/** The calls that read a file's bytes or lines, or hand them to a tool that does. `loadSeenIds` is the receiver's line scan under another name, so a caller of it is a raw reader too. */
const RAW_READ = /\b(readFileSync|readFile|createReadStream|openSync|readSync|createInterface|loadSeenIds|execFileSync|execSync|spawnSync|execFile|spawn)\s*\(/g;
/** What names the store file in the text of a call: the default path, the `--store` flag and the names every module gives the path. */
const STORE_TOKEN = /\bdefaultStore\s*\(|events\.ndjson|["']--store["']/;
const STORE_NAMES = ["storePath", "storeFile", "STORE_PATH", "store"];
/** A tool that reads a file's lines for a person's script. A `spawnSync(node, [trace.ts, "--store", path])` hands the path to a reader that goes through `readStore`, and is not one. */
const LINE_TOOLS = /^["'](cat|jq|grep|awk|sed|head|tail|wc|sort|python3?|bash|sh|zsh|perl|rg|ugrep)["']/;
const SPAWNERS = new Set(["execFileSync", "execSync", "spawnSync", "execFile", "spawn"]);

/** The text of the call whose `(` is at `open`, to its closing `)`, skipping string literals. */
function callText(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      for (index += 1; index < source.length && source[index] !== char; index += 1) if (source[index] === "\\") index += 1;
    } else if (char === "(") depth += 1;
    else if (char === ")" && (depth -= 1) === 0) return source.slice(open + 1, index);
  }
  return source.slice(open + 1);
}

/** The first argument of a call's text: up to the first comma outside brackets and strings. */
function firstArgument(args: string): string {
  let depth = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (char === '"' || char === "'" || char === "`") {
      for (index += 1; index < args.length && args[index] !== char; index += 1) if (args[index] === "\\") index += 1;
    } else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) return args.slice(0, index);
  }
  return args;
}

/** The names a module gives the store path: the usual ones, and what is assigned on a line that names the default path or the flag. */
function storeNames(source: string): string[] {
  const names = new Set(STORE_NAMES);
  for (const line of source.split("\n")) {
    if (!STORE_TOKEN.test(line)) continue;
    for (const found of line.matchAll(/(?:const|let|var)\s+(\w+)\s*=|\bstore:\s*(\w+)/g)) names.add(found[1] ?? found[2]);
  }
  // A name assigned from one of those names by an alias or an index (`const file = argv[flag + 1]` after `const flag = argv.indexOf("--store")`) is the path as well, to a fixed point.
  // Not through a call: `stateFileFor(storePath)` is the ingest state's file, which is beside the store and is not it.
  for (let grew = true; grew;) {
    grew = false;
    for (const found of source.matchAll(/(?:const|let|var)\s+(\w+)\s*=([^\n]*)/g)) {
      if (!names.has(found[1]) && !found[2].includes("(") && [...names].some((name) => new RegExp(`\\b${name}\\b`).test(found[2]))) {
        names.add(found[1]);
        grew = true;
      }
    }
  }
  return [...names];
}

/** The `file:line` of each raw read of a store path in the module sources under `root` (tests and fixtures are not modules that report). */
function rawStoreReads(root: string, files: string[] = sources(root)): { file: string; line: number; text: string; }[] {
  const found: { file: string; line: number; text: string; }[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const names = new RegExp(`\\b(?:${storeNames(source).join("|")})\\b`);
    for (const call of source.matchAll(RAW_READ)) {
      const args = callText(source, (call.index ?? 0) + call[0].length - 1);
      const aimed = SPAWNERS.has(call[1]) ? LINE_TOOLS.test(firstArgument(args).trim()) && (STORE_TOKEN.test(args) || names.test(args)) : STORE_TOKEN.test(firstArgument(args)) || names.test(firstArgument(args));
      if (aimed) found.push({ file, line: source.slice(0, call.index).split("\n").length, text: `${call[1]}(${args.slice(0, 80)}` });
    }
  }
  return found;
}

/** The modules under `root`: `.ts` and `.mjs`, not tests, not fixtures. Paths are relative to `root`. */
function sources(root: string, dir = "src"): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" || entry.name === "node_modules" ? [] : sources(root, path);
    return /\.(ts|mjs)$/.test(entry.name) && !/\.test\.(ts|mjs)$/.test(entry.name) && path !== OWNER ? [path] : [];
  });
}

/** A scratch tree with each module written under `src/`. */
function tree(modules: Record<string, string>) {
  const { dir } = scratch("trace-readers-tree-");
  for (const [name, text] of Object.entries(modules)) {
    mkdirSync(dirname(join(dir, "src", name)), { recursive: true });
    writeFileSync(join(dir, "src", name), text);
  }
  return dir;
}

const SUMS_RAW = [
  'import { readFileSync } from "node:fs";',
  'import { defaultStore } from "../trace/otel-receiver.ts";',
  'const total = readFileSync(defaultStore(), "utf8").split("\\n").filter(Boolean).reduce((sum, line) => sum + JSON.parse(line).costUsd, 0);',
  "console.log(total);",
].join("\n");
const SUMS_RAW_FLAG = [
  'import { createReadStream } from "node:fs";',
  'import { createInterface } from "node:readline";',
  'const flag = process.argv.indexOf("--store");',
  "const file = process.argv[flag + 1];",
  "let total = 0;",
  "for await (const line of createInterface({ input: createReadStream(file) })) total += JSON.parse(line).costUsd;",
].join("\n");
const SUMS_RAW_BY_TOOL = ['import { execFileSync } from "node:child_process";', 'const storePath = process.argv[2];', 'console.log(execFileSync("jq", ["-s", "map(.costUsd) | add", storePath]).toString());'].join("\n");
const READS_THROUGH = [
  'import { readStore, repriceEvents } from "../trace/store.ts";',
  'import { defaultStore } from "../trace/otel-receiver.ts";',
  "console.log(repriceEvents(readStore(defaultStore())).length);",
].join("\n");
const READS_OTHER_FILES = [
  'import { readFileSync } from "node:fs";',
  'import { defaultStore } from "../trace/otel-receiver.ts";',
  'const ledger = readFileSync(join(cache, "wake-ledger"), "utf8");',
  "console.log(ledger.length, defaultStore());",
].join("\n");

test("the scan reports a fixture module that sums the store's lines raw, by each way it can be written", () => {
  const root = tree({ "report/sum-default.ts": SUMS_RAW, "report/sum-flag.ts": SUMS_RAW_FLAG, "report/sum-tool.ts": SUMS_RAW_BY_TOOL });
  const reported = [...new Set(rawStoreReads(root).map((found) => found.file))].sort();
  assert.deepEqual(reported, ["src/report/sum-default.ts", "src/report/sum-flag.ts", "src/report/sum-tool.ts"]);
});

test("negative control: a module that reads through readStore, and one that reads other files, are not reported; and the remedy of a reported one stops the report", () => {
  const root = tree({ "report/through.ts": READS_THROUGH, "report/other.ts": READS_OTHER_FILES, "report/sum-default.ts": SUMS_RAW });
  assert.deepEqual(rawStoreReads(root).map((found) => found.file), ["src/report/sum-default.ts"]);
  writeFileSync(join(root, "src/report/sum-default.ts"), READS_THROUGH);
  assert.deepEqual(rawStoreReads(root), [], "the remedy applied: the same module is no longer reported");
});

test("negative control: the scan passes haiku-tier-report.ts and trace.ts as they stand, which read through readStore and openStore", () => {
  const readers = ["src/trace/haiku-tier-report.ts", "src/trace/trace.ts"];
  for (const file of readers) assert.match(readFileSync(join(ROOT, file), "utf8"), /\b(readStore|openStore)\(/, `${file} reads through the store's own functions`);
  assert.deepEqual(rawStoreReads(ROOT, readers), []);
});

test("no module under src/ reads the store file's lines itself, but the named exceptions, each of which still does", () => {
  const found = rawStoreReads(ROOT);
  assert.ok(sources(ROOT).length > 100, "the scan walked the tree");
  const unexplained = found.filter((read) => !(read.file in ALLOWED));
  assert.deepEqual(unexplained.map((read) => `${read.file}:${read.line} ${read.text}`), [], "read the file through readStore, openStore or duplicateIds; or name the module in ALLOWED with the reason");
  for (const file of Object.keys(ALLOWED)) assert.ok(found.some((read) => read.file === file), `${file} is still a raw reader, so its exception is still needed (and is not a dead entry)`);
  for (const [file, reason] of Object.entries(ALLOWED)) assert.ok(reason.length > 40, `${file} states a reason`);
});
