// Row #2849 (the split, child 5d-0 of #69): the live gate taps its own `decide` call, for the shadow runner (#2846).
//
// Every claim below runs the real writer against a real temporary directory, and the controls are in this file:
// the marker-absent case is only worth anything beside the marker-present one that writes a file, and the pruner is
// shown removing exactly one of 31. THE ROUND TRIP OF `args` THROUGH `decide` IS IN `shadow-reads-round-trip.test.ts`: it calls
// `decide`, which reaches `work-gate.mjs` and so charges the token-less acceptance job a `token` it would refuse (#827, #2610), and
// this file is the row's Acceptance, so it imports only `shadow-reads.mjs`. #2858 (the Map, Set and Date encoding) follows the same split: what is
// written and read back is HERE, and `decide`'s answer over the revived arguments is in `shadow-reads-round-trip.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_TICKS, SHADOW_READS_DIR, SHADOW_WINDOW_MARKER, encodeShadowValue, parseShadowRecord, pruneShadowReads, reviveShadowValue, tapShadowReads }
  from "../shadow-reads.ts";

const FIRST_TICK = 1_790_000_000_000;
const TWO_MINUTES = 120_000;

/** A fresh state directory, with or without the marker that opens the window. */
function stateDir(open: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "shadow-reads-"));
  if (open) writeFileSync(join(dir, SHADOW_WINDOW_MARKER), "");
  return dir;
}
const recordsIn = (dir: string) => readdirSync(join(dir, SHADOW_READS_DIR)).sort();
const quiet = () => undefined;

/** A tick shaped like the gate's: plain arrays and objects, one open draft PR and one Ready row. */
const FIXTURE_ARGS = () => ({
  primaryDrift: null,
  prs: [{ number: 7, isDraft: true, headRefOid: "abc12345deadbeefcafe000011112222",
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    author: { login: "worker-judge" }, comments: [{ body: "a comment" }], labels: [{ name: "lane:any" }] }],
  readyRows: [{ number: 9001, title: "a ready row", labels: [] }],
  promotableRows: [], chairmanBlocked: [], prFiles: [], drain: false,
});

test("marker ABSENT: a tap writes nothing and creates no directory -- and the same call with the marker present writes (the control)", () => {
  const closed = stateDir(false);
  const open = stateDir(true);
  try {
    const result = tapShadowReads({ args: FIXTURE_ARGS(), orders: [], tick: FIRST_TICK, stateDir: closed, log: quiet });
    assert.deepEqual(result, { recorded: false });
    assert.deepEqual(readdirSync(closed), [], "nothing at all was created, the directory included");
    // POSITIVE CONTROL: the identical call, marker present, gives a file -- so the emptiness above is not a tap that never writes.
    const written = tapShadowReads({ args: FIXTURE_ARGS(), orders: [], tick: FIRST_TICK, stateDir: open, log: quiet });
    assert.equal(written.recorded, true);
    assert.deepEqual(recordsIn(open), [`${FIRST_TICK}.json`]);
  } finally {
    rmSync(closed, { recursive: true, force: true });
    rmSync(open, { recursive: true, force: true });
  }
});

test("marker present: one call writes one `<tick>.json` carrying `args` and `orders`, and a second writes a second and rewrites neither", () => {
  const dir = stateDir(true);
  try {
    const args = FIXTURE_ARGS();
    const orders = [{ cause: "ready-row-unclaimed", session: "worker-4" }];
    tapShadowReads({ args, orders, tick: FIRST_TICK, stateDir: dir, log: quiet });
    const firstFile = join(dir, SHADOW_READS_DIR, `${FIRST_TICK}.json`);
    const firstBytes = readFileSync(firstFile, "utf8");
    assert.deepEqual(JSON.parse(firstBytes), { tick: FIRST_TICK, args, orders });

    const second = FIRST_TICK + TWO_MINUTES;
    tapShadowReads({ args, orders: [], tick: second, stateDir: dir, log: quiet });
    assert.deepEqual(recordsIn(dir), [`${FIRST_TICK}.json`, `${second}.json`]);
    assert.equal(readFileSync(firstFile, "utf8"), firstBytes, "the first record is byte-identical after the second call");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, SHADOW_READS_DIR, `${second}.json`), "utf8")).orders, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded: the thirty-first call leaves 30 files and removes the OLDEST; no `.tmp` name survives", () => {
  const dir = stateDir(true);
  try {
    const ticks = Array.from({ length: KEEP_TICKS + 1 }, (_, i) => FIRST_TICK + i * TWO_MINUTES);
    for (const tick of ticks.slice(0, KEEP_TICKS)) tapShadowReads({ args: {}, orders: [], tick, stateDir: dir, log: quiet });
    assert.equal(recordsIn(dir).length, KEEP_TICKS, "thirty calls keep all thirty -- the bound has not fired early");
    tapShadowReads({ args: {}, orders: [], tick: ticks[KEEP_TICKS], stateDir: dir, log: quiet });
    const names = recordsIn(dir);
    assert.equal(names.length, KEEP_TICKS);
    assert.ok(!names.includes(`${ticks[0]}.json`), "the oldest went");
    assert.ok(names.includes(`${ticks[1]}.json`) && names.includes(`${ticks[KEEP_TICKS]}.json`), "the second-oldest and the newest stayed");
    assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), [], "no temp name survives a successful write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pruner, given 31 files, removes exactly one -- the oldest, by NUMBER and not by name (positive control)", () => {
  const dir = stateDir(false);
  try {
    // 9 digits then 10: a string sort would put "10..." before "9..." and remove the wrong one.
    const ticks = [999_999_999, ...Array.from({ length: KEEP_TICKS }, (_, i) => 1_000_000_000 + i)];
    for (const tick of ticks) writeFileSync(join(dir, `${tick}.json`), "{}");
    const { removed, diagnostics } = pruneShadowReads(dir);
    assert.deepEqual(removed, ["999999999.json"]);
    assert.deepEqual(diagnostics, []);
    assert.equal(readdirSync(dir).length, KEEP_TICKS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pruner sweeps temp debris an interrupted write left, and leaves files that are not ticks alone", () => {
  const dir = stateDir(false);
  try {
    writeFileSync(join(dir, ".123.json.tmp"), "half");
    writeFileSync(join(dir, "README"), "not ours");
    writeFileSync(join(dir, "456.json"), "{}");
    const { removed } = pruneShadowReads(dir);
    assert.deepEqual(removed, [".123.json.tmp"]);
    assert.deepEqual(readdirSync(dir).sort(), ["456.json", "README"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write that cannot happen returns a diagnostic naming the cause, writes it to the log, and does not throw", () => {
  const dir = stateDir(true);
  try {
    // The records directory is a FILE, so `mkdir` fails whoever runs this -- unlike a chmod, which root ignores.
    writeFileSync(join(dir, SHADOW_READS_DIR), "in the way");
    const lines: string[] = [];
    const result = tapShadowReads({ args: FIXTURE_ARGS(), orders: [], tick: FIRST_TICK, stateDir: dir, log: (line) => lines.push(line) });
    assert.equal(result.recorded, false);
    assert.match(result.diagnostic ?? "", /could not record tick 1790000000000/);
    assert.match(result.diagnostic ?? "", /EEXIST|ENOTDIR/, "it names the cause, not just the failure");
    assert.equal(lines.length, 1, "and it said so once on the log");
    assert.match(lines[0], /^shadow-reads: .*EEXIST|ENOTDIR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record written but a prune that fails: recorded true, the path, AND the diagnostic returned, and the log line (not stderr alone)", () => {
  const dir = stateDir(true);
  try {
    // A DIRECTORY named like the oldest record: `unlink` refuses it (EISDIR) whoever runs this, root included.
    mkdirSync(join(dir, SHADOW_READS_DIR, "1.json"), { recursive: true });
    const lines: string[] = [];
    const result = tapShadowReads({ args: FIXTURE_ARGS(), orders: [], tick: FIRST_TICK, stateDir: dir, keep: 1, log: (line) => lines.push(line) });
    assert.equal(result.recorded, true, "the record is on disk, so the tap succeeded");
    assert.equal(result.path, join(dir, SHADOW_READS_DIR, `${FIRST_TICK}.json`));
    assert.match(result.diagnostic ?? "", /could not remove .*1\.json/, "the pruning failure reaches the caller, not only stderr");
    assert.match(result.diagnostic ?? "", /EISDIR|EPERM/, "and names its cause");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^shadow-reads: could not remove .*1\.json/);
    assert.ok(existsSync(join(dir, SHADOW_READS_DIR, `${FIRST_TICK}.json`)), "the newest record stayed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an `args` that cannot be serialised is a diagnostic too, not a thrown error out of the tick", () => {
  const dir = stateDir(true);
  try {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = tapShadowReads({ args: circular, orders: [], tick: FIRST_TICK, stateDir: dir, log: quiet });
    assert.equal(result.recorded, false);
    assert.match(result.diagnostic ?? "", /circular/i);
    assert.equal(existsSync(join(dir, SHADOW_READS_DIR, `${FIRST_TICK}.json`)), false, "and no record was left behind");
    assert.deepEqual(readdirSync(join(dir, SHADOW_READS_DIR)).filter((name) => name.endsWith(".json")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable state directory is a diagnostic as well (skipped honestly when the process may write anyway)", (t) => {
  const dir = stateDir(true);
  try {
    mkdirSync(join(dir, SHADOW_READS_DIR));
    chmodSync(join(dir, SHADOW_READS_DIR), 0o500);
    // root ignores the mode bits, and a test that passes for that reason proves nothing -- so say it is skipped.
    if (process.getuid?.() === 0) return t.skip("running as root: mode bits do not bind, the file-in-the-way test above covers the failure");
    const result = tapShadowReads({ args: {}, orders: [], tick: FIRST_TICK, stateDir: dir, log: quiet });
    assert.equal(result.recorded, false);
    assert.match(result.diagnostic ?? "", /EACCES/);
  } finally {
    chmodSync(join(dir, SHADOW_READS_DIR), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #2858: a Map, a Set and a Date are tagged on the way out and revived on the way in; anything else non-plain is named -----------------

/** Write `args` through the real tap into a fresh open window, and read the file back the way the runner does. */
function tapAndRead(args: unknown, lines: string[] = []) {
  const dir = stateDir(true);
  try {
    const result = tapShadowReads({ args, orders: [], tick: FIRST_TICK, stateDir: dir, log: (line) => lines.push(line) });
    const file = join(dir, SHADOW_READS_DIR, `${FIRST_TICK}.json`);
    return { result, text: existsSync(file) ? readFileSync(file, "utf8") : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One of each type, a numeric key and a value, a Map inside an array, and a Set holding a Map -- the shapes `decide`'s arguments could grow. */
const TYPED_ARGS = () => ({
  closings: new Map([[2846, 1_790_000_000_000], [2849, 5]]),
  seen: new Set(["a", 2, null]),
  when: new Date("2026-10-01T09:46:00.000Z"),
  nested: [new Map([["inner", new Map([[1, new Set([3])]])]]), { plain: [1, "two", false, null] }],
  prs: [{ number: 7, labels: [{ name: "lane:any" }] }],
});

test("a Map (numeric key and value), a Set, a Date and a Map inside an array come back EQUAL by type and content", () => {
  const args = TYPED_ARGS();
  const { result, text } = tapAndRead(args);
  assert.equal(result.recorded, true);
  assert.equal(result.diagnostic, undefined, "nothing here is a type the tap cannot encode");
  const back = parseShadowRecord(text ?? "").args;
  assert.deepEqual(back, args, "equal by type and content (`deepEqual` is strict about a Map against `{}` and a Date against a string)");
  assert.ok(back.closings instanceof Map && back.seen instanceof Set && back.when instanceof Date && back.nested[0] instanceof Map);
  assert.equal(back.closings.get(2846), 1_790_000_000_000, "the key is still the NUMBER 2846, which an object's string key would not be");
  assert.ok(back.nested[0].get("inner")?.get(1) instanceof Set, "and a Map inside a Map inside an array survives");
});

test("POSITIVE CONTROL: the same arguments written with a bare JSON.stringify do NOT come back equal, so the check above can fail", () => {
  const args = TYPED_ARGS();
  const bare = JSON.parse(JSON.stringify({ tick: FIRST_TICK, args, orders: [] }), reviveShadowValue).args;
  assert.throws(() => assert.deepEqual(bare, args), "the reviver cannot rebuild what was never tagged");
  assert.deepEqual(bare.closings, {}, "the defect itself: a Map written as `{}`");
  assert.equal(typeof bare.when, "string", "and a Date written as a string");
});

test("a record with no tags at all reads unchanged, and so does an object whose `$type` is some other value", () => {
  const legacy = { tick: FIRST_TICK, args: FIXTURE_ARGS(), orders: [{ cause: "x" }] };
  assert.deepEqual(parseShadowRecord(JSON.stringify(legacy)), legacy, "a tick file written before #2858 still reads");
  const strangers = { a: { $type: "Weird", entries: [[1, 2]] }, b: { $type: "Map" }, c: { $type: "Map", entries: [[1, 2, 3]] }, d: { $type: "Date", iso: 5 }, e: { $type: 7 } };
  assert.deepEqual(parseShadowRecord(JSON.stringify(strangers)), strangers, "an unknown tag, or a known tag of the wrong shape, is returned as it was");
});

test("an invalid Date survives as an invalid Date, and an empty Map and Set as empty ones", () => {
  const back = parseShadowRecord(JSON.stringify(encodeShadowValue({ d: new Date(Number.NaN), m: new Map(), s: new Set() }).encoded));
  assert.ok(back.d instanceof Date && Number.isNaN(back.d.getTime()));
  assert.deepEqual([back.m, back.s], [new Map(), new Set()]);
});

test("a class instance in `args`: ONE diagnostic naming its key path and constructor, no throw, and the file is still written", () => {
  class Surprise { constructor(public value = 1) {} }
  const lines: string[] = [];
  const { result, text } = tapAndRead({ ...TYPED_ARGS(), prs: [{ number: 7, extra: new Surprise() }] }, lines);
  assert.equal(result.recorded, true, "the tick carries on and the record is on disk");
  assert.match(result.diagnostic ?? "", /args\.prs\[0\]\.extra is a Surprise/, "the key path and the constructor");
  assert.equal(lines.length, 1, "exactly one diagnostic, not zero (positive control) and not one per field");
  assert.match(lines[0], /^shadow-reads: args\.prs\[0\]\.extra is a Surprise/);
  assert.ok(text !== null && parseShadowRecord(text).args.closings instanceof Map, "and the Map beside it was still tagged");
});

test("POSITIVE CONTROL: the same arguments with plain objects only produce NO diagnostic, so the one above is the class's doing", () => {
  const lines: string[] = [];
  const { result } = tapAndRead({ ...TYPED_ARGS(), prs: [{ number: 7, extra: { value: 1 } }] }, lines);
  assert.deepEqual([result.recorded, result.diagnostic, lines], [true, undefined, []]);
});

test("a bigint, a function and a symbol are named and left out, and a plain object carrying a known `$type` is named as ambiguous", () => {
  const { diagnostics, encoded } = encodeShadowValue({ big: 1n, fn: () => 1, sym: Symbol("s"), lookalike: { $type: "Set", values: [1] }, ok: 1 });
  assert.equal(diagnostics.length, 4);
  assert.match(diagnostics.join("\n"), /args\.big is a bigint/);
  assert.match(diagnostics.join("\n"), /args\.fn is a function/);
  assert.match(diagnostics.join("\n"), /args\.sym is a symbol/);
  assert.match(diagnostics.join("\n"), /args\.lookalike holds \$type "Set"/);
  assert.equal(JSON.stringify(encoded).includes("\"big\""), false, "the bigint did not make `JSON.stringify` throw");
});

test("a tick of 40 unencodable values logs a bounded number of lines, and says that it stopped listing", () => {
  const { diagnostics } = encodeShadowValue({ many: Array.from({ length: 40 }, () => 1n) });
  assert.equal(diagnostics.length, 11, "ten named, then one line saying more were left out");
  assert.match(diagnostics[10], /and more/);
});

test("a cycle through a Map is named by its key path, and still a diagnostic and not a throw from `tapShadowReads`", () => {
  const loop = new Map<string, unknown>();
  loop.set("self", loop);
  const lines: string[] = [];
  const { result, text } = tapAndRead({ loop }, lines);
  assert.equal(result.recorded, false);
  assert.match(result.diagnostic ?? "", /circular structure at args\.loop\.entries\[0\]\[1\]/);
  assert.equal(text, null);
});
