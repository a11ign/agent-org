// no-token: pure -- both readings are functions of values handed in; the one disk read (`readDeclaredCopies`) is given a fake `list`/`read` or reads this checkout's own files, and nothing here calls `gh`, ssh or the fleet.
/**
 * `packages/agent-org/src/org-health.mjs`, #2937: TWO MORE QUESTIONS THE GATE ASKS ABOUT THE ORG -- a fleet that has captured nothing for a day while something waits for it,
 * and two copies of the same file that have stopped being the same.
 *
 * THE THRESHOLD IS WRITTEN OUT AS 24 HOURS HERE, NEVER AS `FLEET_IDLE_HOURS`: a test built from the constant moves with it (`org-health.test.ts`'s rule, for its reason).
 *
 * POSITIVE CONTROLS. The idle fleet is replayed as the chairman described it: zero captures for 4.9 days with a `fleet-gated` row waiting. The copies' control is a
 * RECORDED `isolation-gate.mjs` pair (`fixtures/org-health-fleet-and-copies/`, the shape of the real one -- a header naming two import lines -- under a `.txt` suffix, so no tool that walks the tree's modules reads it as one), with ONE BYTE changed: every
 * "does not trip" below is only worth anything because that does. The pairs are read clean first, so the control is not true for the wrong reason. THAT THE REAL
 * `lib/` COPIES MATCH A11IGN'S ORIGINALS IS A11IGN'S INVARIANT (its `agent-org-outward-edges.test.ts` applies each sanctioned edit exactly), and moved there (#3233):
 * read against a11ign's live tree, an edit to an original turned this suite red for a change that touched neither side.
 *
 * MUTATIONS, each run by hand and each recorded on the row: drop the `something is waiting` condition from `fleetIdleReading` (the idle-nobody-needs test goes red and
 * only it), and compare a pair with itself in `judgePair` (the control goes red, and the "differs" test with it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLEET_IDLE_HOURS, SIGNALS, fleetIdleReading, copyDriftReading, readDeclaredCopies, orgHealthReadings, orgHealthOrders, orgHealthTick,
} from "../org-health.ts";

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const ISOLATION = "src/lib/isolation-gate.mjs.txt";
/** A recorded project and tool tree holding two copied files and their originals, and one file of `lib/` that is no copy (#3233). */
const FIXTURE = fileURLToPath(new URL("./fixtures/org-health-fleet-and-copies/", import.meta.url));
const FIXTURE_PROJECT = join(FIXTURE, "project");
const FIXTURE_TOOL = join(FIXTURE, "tool");
const FIXTURE_LIB = join(FIXTURE_TOOL, "src/lib");

const WAITING = { rows: [2870], labJobs: [] as string[] };
const NOTHING_WAITING = { rows: [] as (number | string)[], labJobs: [] as string[] };
const IDLE_FOR_A_DAY = { captures24h: 0, lastCaptureAt: NOW - 24 * HOUR_MS };

type Pair = NonNullable<ReturnType<typeof readDeclaredCopies>>[number];

/** One synthetic pair whose copy is the original under a header naming `changes`. */
const header = (changes: string) => `// COPIED FROM \`a/orig.mjs\` at abcdef123 (#1): a test copy.\n// CHANGED FROM THE ORIGINAL${changes}\n// ==== end of copy header ====\n`;
const pairOf = (over: Partial<Pair> = {}): Pair => ({
  original: "a/orig.mjs", copy: "b/lib/orig.mjs", originalText: "one\ntwo\nthree\n",
  copyText: `${header(": NOTHING but this header.")}one\ntwo\nthree\n`, allowedLines: 0, ...over,
});

const recordedPairs = () => readDeclaredCopies({ root: FIXTURE_PROJECT, toolRoot: FIXTURE_TOOL }) as Pair[];

// --- the constant is the row's -------------------------------------------------------------------------------------------

test("the idle window is the chairman's 24 hours, written out here and pinned to the export", () => {
  assert.equal(FLEET_IDLE_HOURS, 24);
});

// --- 1. fleet-idle-while-work-waits ---------------------------------------------------------------------------------------

test("fleet idle: zero captures for 24 h with a row waiting TRIPS, and the detail carries the count and the last-capture time", () => {
  const reading = fleetIdleReading({ now: NOW, fleet: IDLE_FOR_A_DAY, waiting: WAITING });
  assert.equal(reading.status, "tripped");
  assert.equal(reading.signal, "fleet-idle-while-work-waits");
  assert.match(reading.detail, /^0 captures in the last 24 h/, "the count");
  assert.match(reading.detail, /2026-10-01T12:00:00Z/, "the last capture's time");
  assert.match(reading.detail, /#2870/, "what waits");
  assert.equal(reading.firstTrippedAt, NOW, "the last capture plus 24 h, derived rather than remembered");
});

test("fleet idle: a lab job waiting trips it as a row does, and the chairman's 4.9 days is the same reading with a larger age", () => {
  assert.equal(fleetIdleReading({ now: NOW, fleet: IDLE_FOR_A_DAY, waiting: { rows: [], labJobs: ["corpus-recapture"] } }).status, "tripped");
  const days = fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: NOW - 118 * HOUR_MS }, waiting: WAITING });
  assert.equal(days.status, "tripped");
  assert.match(days.detail, /\(118 h ago\)/);
});

test("fleet idle: the SAME idleness with nothing waiting is clear -- an idle fleet nobody needs is healthy", () => {
  assert.equal(fleetIdleReading({ now: NOW, fleet: IDLE_FOR_A_DAY, waiting: NOTHING_WAITING }).status, "clear");
});

test("fleet idle: exactly 24 h trips and one millisecond under does not, the window is tested BEFORE what waits, and a capture inside it is clear", () => {
  assert.equal(fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: NOW - 24 * HOUR_MS }, waiting: WAITING }).status, "tripped");
  const under = fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: NOW - 24 * HOUR_MS + 1 }, waiting: WAITING });
  assert.equal(under.status, "unknown", "zero captures beside a last capture inside the window contradicts itself: said so, believed neither way");
  assert.match(under.detail, /zero captures in the window and a last capture inside it/);
  assert.equal(fleetIdleReading({ now: NOW, fleet: { captures24h: 3, lastCaptureAt: NOW - HOUR_MS }, waiting: null }).status, "clear",
    "a refused waiting read cannot turn a fleet that captured into an unknown");
});

test("fleet idle: an UNREADABLE fleet is unknown, never idle, whatever waits; and an unread waiting list is unknown too", () => {
  const refused = fleetIdleReading({ now: NOW, fleet: null, waiting: WAITING });
  assert.equal(refused.status, "unknown");
  assert.match(refused.detail, /could not be read, so it is not known to be idle/);
  const unasked = fleetIdleReading({ now: NOW, fleet: IDLE_FOR_A_DAY, waiting: null });
  assert.equal(unasked.status, "unknown");
  assert.match(unasked.detail, /what waits for it was not read/);
});

test("fleet idle: with no last-capture time the discriminator is keyed on WHAT WAITS, so a row joining is a new question and the same set is the same one", () => {
  const first = fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: null }, waiting: { rows: [2870], labJobs: [] } });
  const again = fleetIdleReading({ now: NOW + HOUR_MS, fleet: { captures24h: 0, lastCaptureAt: null }, waiting: { rows: [2870], labJobs: [] } });
  const joined = fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: null }, waiting: { rows: [2870, 2871], labJobs: [] } });
  assert.equal(first.status, "tripped");
  assert.equal(first.firstTrippedAt, null);
  assert.equal(first.discriminator, again.discriminator);
  assert.notEqual(first.discriminator, joined.discriminator);
  assert.match(first.detail, /never recorded/);
});

// --- 2. copies-drifted ----------------------------------------------------------------------------------------------------

test("copies: a pair that differs TRIPS and names BOTH paths", () => {
  const reading = copyDriftReading({ pairs: [pairOf({ originalText: "one\nTWO\nthree\n" })] });
  assert.equal(reading.status, "tripped");
  assert.equal(reading.signal, "copies-drifted");
  assert.match(reading.detail, /b\/lib\/orig\.mjs/, "the copy");
  assert.match(reading.detail, /a\/orig\.mjs/, "the original");
  assert.match(reading.detail, /1 line\(s\) only in the copy, 1 only in the original, and its header names 0/);
});

test("copies: two identical copies are clear, and a pair is only 'the same' within the lines its own header names", () => {
  assert.equal(copyDriftReading({ pairs: [pairOf()] }).status, "clear");
  const edited = pairOf({ copyText: `${header(", ONE LINE: an import.")}one\n2\nthree\n`, allowedLines: 1 });
  assert.equal(copyDriftReading({ pairs: [edited] }).status, "clear", "the one named line is the allowance");
  const twice = pairOf({ copyText: `${header(", ONE LINE: an import.")}1\n2\nthree\n`, allowedLines: 1 });
  assert.equal(copyDriftReading({ pairs: [twice] }).status, "tripped", "two changed lines against a header naming one");
});

test("copies: ONE named line may become several (the #2884 shape), a header naming NOTHING allows no extra line, and an unnamed original line is still drift", () => {
  const expanded = pairOf({ copyText: `${header(", ONE LINE: `two` became three lines.")}one\ntwo-a\n\ntwo-b\nthree\n`, originalText: "one\ntwo\nthree\n", allowedLines: 1 });
  assert.equal(copyDriftReading({ pairs: [expanded] }).status, "clear", "one original line changed, named once, however many lines it became");
  const unnamedAddition = pairOf({ copyText: `${header(": NOTHING but this header.")}one\ntwo\nthree\nfour\n`, allowedLines: 0 });
  assert.equal(copyDriftReading({ pairs: [unnamedAddition] }).status, "tripped", "a header that names nothing above an extra line");
  const unnamedChange = pairOf({ copyText: `${header(", ONE LINE: an import.")}ONE\nTWO\nthree\n`, allowedLines: 1 });
  assert.equal(copyDriftReading({ pairs: [unnamedChange] }).status, "tripped", "two of the original's lines changed against a header naming one");
});

test("copies: a moved line is not an edit, a copy with no complete header has drifted, and a header that gives no count is unknown", () => {
  assert.equal(copyDriftReading({ pairs: [pairOf({ originalText: "three\none\ntwo\n" })] }).status, "clear");
  const headless = pairOf({ copyText: "// COPIED FROM `a/orig.mjs` at abcdef123 (#1): no end.\none\ntwo\nthree\n" });
  assert.equal(copyDriftReading({ pairs: [headless] }).status, "tripped");
  assert.match(copyDriftReading({ pairs: [headless] }).detail, /no complete header/);
  const uncounted = copyDriftReading({ pairs: [pairOf({ allowedLines: null })] });
  assert.equal(uncounted.status, "unknown");
  assert.match(uncounted.detail, /does not say how many lines/);
});

test("copies: an unreadable original, an unreadable directory and an EMPTY discovery are each unknown, never clear -- and a drifted pair still trips beside an unread one", () => {
  assert.equal(copyDriftReading({ pairs: [pairOf({ originalText: null })] }).status, "unknown");
  assert.equal(copyDriftReading({ pairs: null }).status, "unknown");
  const none = copyDriftReading({ pairs: [] });
  assert.equal(none.status, "unknown");
  assert.match(none.detail, /none was compared/);
  const mixed = copyDriftReading({ pairs: [pairOf({ originalText: null }), pairOf({ originalText: "one\nTWO\nthree\n" })] });
  assert.equal(mixed.status, "tripped");
});

// --- the positive control: a RECORDED pair ---------------------------------------------------------------------------------

test("control: the recorded tree's declared copies are discovered, every original is readable, and the pair set is CLEAN", () => {
  const pairs = recordedPairs();
  // The count is derived a second way, by a plain scan for a line opening with the header's first words, and asserted EQUAL: a floor is satisfied by 19, by 58 and by 157 (reported-counts.test.ts).
  const files = readdirSync(FIXTURE_LIB);
  const headed = files.filter((name) => readFileSync(join(FIXTURE_LIB, name), "utf8").match(/^\/\/ COPIED FROM `/m));
  assert.equal(pairs.length, headed.length, `discovery found ${pairs.length} pairs and a scan of lib/ finds ${headed.length} headed files`);
  assert.equal(headed.length, 2, "the scan is not empty: the recorded copies are what the control compares");
  assert.ok(files.length > headed.length, "and a file of lib/ with no header is in the directory, so discovery SKIPPING it is what the count above shows");
  assert.ok(pairs.some((pair) => pair.copy === ISOLATION && pair.original === "packages/guards/src/isolation-gate.mjs.txt"), "the pair with a header naming two lines");
  assert.deepEqual(pairs.filter((pair) => pair.originalText === null).map((pair) => pair.copy), [], "an unreadable original would make 'clean' mean 'not asked'");
  assert.equal(copyDriftReading({ pairs }).status, "clear", copyDriftReading({ pairs }).detail);
});

test("control: the recorded isolation-gate pair with ONE BYTE changed in the original trips, naming both paths -- and the same byte in the copy trips too", () => {
  const pairs = recordedPairs();
  const real = pairs.find((pair) => pair.copy === ISOLATION) as Pair;
  assert.ok(real.originalText !== null && real.originalText.includes("const "), "the byte this mutates must exist");
  const original = real.originalText as string;
  const changedOriginal = pairs.map((pair) => (pair === real ? { ...pair, originalText: original.replace("const ", "cnst ") } : pair));
  const reading = copyDriftReading({ pairs: changedOriginal });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /src\/lib\/isolation-gate\.mjs\.txt against packages\/guards\/src\/isolation-gate\.mjs\.txt/);
  const changedCopy = pairs.map((pair) => (pair === real ? { ...pair, copyText: pair.copyText.replace("const ", "cnst ") } : pair));
  assert.equal(copyDriftReading({ pairs: changedCopy }).status, "tripped");
  const untouched = changedCopy.filter((pair) => pair !== changedCopy.find((p) => p.copy === ISOLATION));
  assert.equal(untouched.length, 1, "POSITIVE CONTROL: one other pair is left, so the `clear` below is a reading and not 'none was compared'");
  assert.equal(copyDriftReading({ pairs: untouched }).status, "clear", "the other pair is untouched, so the trip is the one pair's");
});

// --- discovery ------------------------------------------------------------------------------------------------------------

test("discovery: an unlistable directory is null, a file with no copy header is skipped, and a header's count is read as NOTHING, ONE LINE or N", () => {
  assert.equal(readDeclaredCopies({ root: "/r", toolRoot: "/tool", list: () => { throw new Error("EACCES"); } }), null);
  const files: Record<string, string> = {
    "/tool/src/lib/plain.mjs": "export {};\n",
    "/tool/src/lib/none.mjs": `${header(": NOTHING but this header.")}x\n`,
    "/tool/src/lib/one.mjs": `${header(", ONE LINE: an import.")}x\n`,
    "/tool/src/lib/three.mjs": `${header(", 3 NAMED LINES:")}x\n`,
    "/r/a/orig.mjs": "x\n",
  };
  const pairs = readDeclaredCopies({
    root: "/r", toolRoot: "/tool", list: () => ["three.mjs", "plain.mjs", "one.mjs", "none.mjs"],
    read: (path) => { if (path in files) return files[path]; throw new Error(`ENOENT ${path}`); },
  }) as Pair[];
  assert.deepEqual(pairs.map((pair) => [pair.copy.split("/").pop(), pair.allowedLines]), [["none.mjs", 0], ["one.mjs", 1], ["three.mjs", 3]].sort(),
    "plain.mjs holds no header and is not a copy");
  assert.ok(pairs.every((pair) => pair.original === "a/orig.mjs" && pair.originalText === "x\n"));
});

// --- the cause: both ride `org-health` --------------------------------------------------------------------------------------

test("both signals are OFFERED to ceo through the org-health cause, with the numbers in the prompt and the other tripped signals named", () => {
  const facts = { now: NOW, lastMergedAt: NOW - HOUR_MS, work: null, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] as string[] }, primarySince: null };
  const readings = orgHealthReadings({ ...facts, fleet: IDLE_FOR_A_DAY, waiting: WAITING, copies: [pairOf({ originalText: "one\nTWO\nthree\n" })] });
  const orders = orgHealthOrders(readings);
  assert.deepEqual(orders.map((o) => [o.session, o.cause, o.subject]), [["ceo", "org-health", SIGNALS.FLEET_IDLE], ["ceo", "org-health", SIGNALS.COPIES]]);
  assert.match(orders[0].prompt, /0 captures in the last 24 h/);
  assert.match(orders[0].prompt, /`orchestrator` owns fleet and lab questions/);
  assert.match(orders[0].prompt, /ALSO TRIPPED \(1\): copies-drifted\./);
  assert.match(orders[1].prompt, /b\/lib\/orig\.mjs against a\/orig\.mjs/);
  assert.match(orders[1].causeKey, /^ceo\/org-health\/copies-drifted@b\/lib\/orig\.mjs$/);
});

test("an OMITTED fleet fact is silent (the caller does not ask), a NULL one is a stated unknown, and the tick never reports a refusal as a trip", () => {
  const facts = { now: NOW, lastMergedAt: NOW - HOUR_MS, work: null, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] as string[] }, primarySince: null, copies: [] as Pair[] };
  assert.equal(orgHealthReadings({ ...facts }).some((r) => r.signal === SIGNALS.FLEET_IDLE), false, "no fleet fact: no reading, so no unknown every tick");
  const said: string[] = [];
  const orders = orgHealthTick({ ...facts, fleet: null } as never, { log: (line) => said.push(line) });
  assert.deepEqual(orders, []);
  assert.match(said.join(""), /org-health: fleet-idle-while-work-waits UNKNOWN -- the fleet's captures could not be read, so it is not known to be idle; it is not read as clear\./);
});

test("the tick reads the copies itself when none are given: a drifted pair is offered, a refusal is said, and a tree with no original is left out", () => {
  const facts = { now: NOW, lastMergedAt: NOW - HOUR_MS, work: null, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] as string[] }, primarySince: null, autoOff: { refusal: null, readAt: NOW } };
  const drifted = orgHealthTick(facts as never, { log: () => {}, readCopies: () => [pairOf({ originalText: "one\nTWO\nthree\n" })] });
  assert.deepEqual(drifted.map((o) => o.subject), [SIGNALS.COPIES]);
  const said: string[] = [];
  orgHealthTick(facts as never, { log: (line) => said.push(line), readCopies: () => null });
  assert.match(said.join(""), /org-health: copies-drifted UNKNOWN -- the declared copies could not be read/);
  const standalone: string[] = [];
  assert.deepEqual(orgHealthTick(facts as never, { log: (line) => standalone.push(line), readCopies: () => [pairOf({ originalText: null })] }), []);
  assert.deepEqual(standalone, [], "an extracted tool holds the headers and not the originals: nothing to compare, and not an unknown that repeats forever");
});
