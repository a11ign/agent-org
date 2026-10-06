// no-token: pure -- the reading is a function of values handed in; the one disk read (`readAutoOffRefusal`) is given a fake `read` or a temporary directory, and nothing here calls `gh`, ssh or the fleet.
/**
 * `src/org-health.mjs`, #3853 (incident #3846, 2b): A FLEET WHOSE AUTO-OFF HAS REFUSED FOR OVER FIFTEEN MINUTES IS RAISED, because a safety refusal nobody reads is an outage.
 *
 * THE THRESHOLDS ARE WRITTEN OUT HERE (15 minutes, 5 minutes, 120 minutes), NEVER AS THE EXPORTS: a test built from the constant moves with it (`org-health.test.ts`'s rule). Every age is
 * built from `NOW` and a number of minutes, so a boundary is a boundary and not a coincidence of the clock.
 *
 * WHAT THE RECORD IS, read at the claim from `fleet-auto-off.mjs` (a11y-witness `packages/control/src`): `runs/fleet-auto-off-state.json` on the CONTROL PLANE, whose `refusal`
 * is `{ reason, detail, at }` with `at` REWRITTEN EVERY TEN SECONDS, so it dates the last tick and never the first. THE FIRST IS `since` (#3859, the producer's to write): a record
 * without it is an UNKNOWN that says so (tested below), because falling back to `at` would read every standing refusal as seconds old. THE TICK DOES NOT READ THAT FILE: it reads
 * the MIRROR `fleet-watch` writes after its hourly ssh read (#3860, ruled by product-manager on #3853), `runs/fleet-auto-off-mirror.json` as `{ readAt, record }`, so the mirror is
 * up to an hour old by design. A mirror read longer than 120 minutes ago is an unknown (the watcher did not look), and the 5-minute "the timer had stopped" rule on `record.at`
 * is judged against `readAt` and not the tick's clock.
 *
 * POSITIVE CONTROLS. A refusal 16 minutes old and unbroken TRIPS and 14 does not, from the same builder, so every "does not trip" is only worth something because that one does. The file
 * read is controlled by a refusal written to a real temporary directory and read back through the real path. MUTATIONS, each run by hand and each recorded on the row: never trip
 * (the 16-minute test goes red), always trip (the 14-minute and the proceeded tests go red, and only they), date the age from `at` (the 16-minute test goes red), and read a
 * missing `since` as clear (the no-`since` test goes red and only it).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health.test.ts`'s #3233 rule, in short): `org-health.mjs` resolves the checkout it serves when it is imported, and with no
// `$AGENT_ORG_HOST` that is wherever the suite happens to be run from, which refuses. The host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "org-health-auto-off-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const {
  AUTO_OFF_MIRROR_PATH, AUTO_OFF_MIRROR_STALE_MINUTES, AUTO_OFF_RECORD_STALE_MINUTES, AUTO_OFF_REFUSAL_MINUTES, ORDER_STALL_MINUTES, SIGNALS, autoOffRefusalReading,
  orgHealthOrders, orgHealthReadings, orgHealthTick, parseAutoOffMirror, readAutoOffRefusal,
} = await import("./org-health.mjs");

const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-10-06T17:00:00Z");
const SIGNAL = "fleet-auto-off-refusing";

/** WHEN THE MIRROR WAS READ in these tests unless one says otherwise: a minute before the tick, so the last tick it saw is 10 s before that. */
const READ_AT = NOW - MINUTE_MS;
/** A refusal whose first tick was `minutes` before the tick and whose last was ten seconds before the mirror read it (never before the first), the shape the timer leaves while it is still ticking. */
const refusing = (minutes: number, over: Record<string, unknown> = {}, readAt = READ_AT) => {
  const since = NOW - minutes * MINUTE_MS;
  return { refusal: { reason: "stale-checkout", detail: "the checkout differs from origin/main", at: Math.max(since, readAt - 10_000), since, ...over }, readAt };
};
/** The mirror as `fleet-watch` writes it, as text. */
const mirrorText = (record: unknown, readAt: unknown = READ_AT) => JSON.stringify({ readAt, record });
const reading = (autoOff: unknown) => autoOffRefusalReading({ now: NOW, autoOff: autoOff as never });

// --- the constants are the row's ------------------------------------------------------------------------------------------------

test("the refusal bound is the chairman's 15 minutes, beside the order-stall bound; the record is believed for 5 minutes, the mirror for 120", () => {
  assert.equal(AUTO_OFF_REFUSAL_MINUTES, 15);
  assert.equal(ORDER_STALL_MINUTES, 15);
  assert.equal(AUTO_OFF_RECORD_STALE_MINUTES, 5);
  assert.equal(AUTO_OFF_MIRROR_STALE_MINUTES, 120);
  assert.equal(AUTO_OFF_MIRROR_PATH, "runs/fleet-auto-off-mirror.json", "the string #3860's writer uses");
  assert.equal(SIGNALS.AUTO_OFF_REFUSING, SIGNAL);
});

// --- the boundary, from one builder ---------------------------------------------------------------------------------------------

test("a refusal 16 minutes old and unbroken TRIPS, naming the reason and the age", () => {
  const r = reading(refusing(16));
  assert.equal(r.status, "tripped");
  assert.equal(r.signal, SIGNAL);
  assert.match(r.detail, /stale-checkout/);
  assert.match(r.detail, /16 min/);
  assert.match(r.detail, /the checkout differs from origin\/main/);
  assert.equal(r.firstTrippedAt, NOW - 16 * MINUTE_MS + 15 * MINUTE_MS, "it first tripped when the 15th minute ended, not when it was read");
});

test("the reason is whatever the record names: fetch-failed and cannot-tell are raised too", () => {
  for (const reason of ["fetch-failed", "cannot-tell"]) {
    const r = reading(refusing(20, { reason }));
    assert.equal(r.status, "tripped");
    assert.match(r.detail, new RegExp(reason));
    assert.match(r.detail, /20 min/);
  }
});

test("a refusal 14 minutes old does not trip, and exactly 15 does not either (strictly over)", () => {
  assert.equal(reading(refusing(14)).status, "clear");
  assert.equal(reading(refusing(15)).status, "clear");
  assert.equal(reading(refusing(15 + 1 / 60)).status, "tripped", "one second over");
});

test("the age is the FIRST refusal's, never the last tick's: a refusal whose last tick is seconds old still trips", () => {
  const r = reading(refusing(16, { at: NOW - 1_000 }));
  assert.equal(r.status, "tripped");
});

test("a record that refuses nothing is clear", () => {
  assert.equal(reading({ refusal: null, readAt: READ_AT }).status, "clear");
});

// --- unbroken: a tick that proceeds resets the age ------------------------------------------------------------------------------------

test("a tick that PROCEEDS ends the run: the next refusal starts a new age, and the old record's trip does not carry over", () => {
  const before = reading(refusing(30));
  assert.equal(before.status, "tripped");
  const proceeded = reading({ refusal: null, readAt: READ_AT });
  assert.equal(proceeded.status, "clear");
  const again = reading(refusing(1));
  assert.equal(again.status, "clear");
  assert.notEqual(reading(refusing(30)).discriminator, reading(refusing(40)).discriminator, "a different start is a different run, so a new order");
});

test("one unbroken run is one signal however long it lasts and however often its reason changes", () => {
  const a = reading(refusing(20, { reason: "stale-checkout" }));
  const b = reading(refusing(20, { reason: "fetch-failed" }));
  assert.equal(a.discriminator, b.discriminator);
});

// --- a record that cannot be believed is a stated unknown --------------------------------------------------------------------------------

test("an unreadable record is UNKNOWN and says why, never clear", () => {
  const r = reading({ unreadable: "`runs/fleet-auto-off-mirror.json` could not be read" });
  assert.equal(r.status, "unknown");
  assert.match(r.detail, /could not be read/);
});

test("a refusal whose last tick was older than the timer can have left it WHEN THE MIRROR READ IT is UNKNOWN: the timer had stopped", () => {
  const r = reading(refusing(60, { at: READ_AT - 6 * MINUTE_MS }));
  assert.equal(r.status, "unknown");
  assert.match(r.detail, /stopped/);
  assert.match(r.detail, /stale-checkout/);
  assert.equal(reading(refusing(60, { at: READ_AT - 4 * MINUTE_MS })).status, "tripped", "four minutes is still a ticking timer");
});

test("the 5-minute rule is judged against `readAt`, NOT the tick's clock: an hour-old mirror of a ticking timer still trips", () => {
  const readAt = NOW - 59 * MINUTE_MS;
  const r = reading(refusing(90, { at: readAt - 10_000 }, readAt));
  assert.equal(r.status, "tripped", "the last tick is 59 minutes before the tick and ten seconds before the read, and the read is what counts");
  assert.match(r.detail, /90 min/);
});

test("a mirror read over 120 minutes ago is UNKNOWN and says the watcher did not look, whatever it held; exactly 120 is still believed", () => {
  for (const held of [refusing(300, { at: NOW - 121 * MINUTE_MS - 10_000 }, NOW - 121 * MINUTE_MS), { refusal: null, readAt: NOW - 121 * MINUTE_MS }]) {
    const r = reading(held);
    assert.equal(r.status, "unknown");
    assert.match(r.detail, /last read off the control plane/);
    assert.match(r.detail, /limit 120 min/);
  }
  assert.equal(reading({ refusal: null, readAt: NOW - 120 * MINUTE_MS }).status, "clear");
  assert.equal(reading({ refusal: null, readAt: NOW - 119 * MINUTE_MS }).status, "clear");
  assert.equal(reading(refusing(300, { at: NOW - 120 * MINUTE_MS - 10_000 }, NOW - 120 * MINUTE_MS)).status, "tripped");
});

test("a refusal with no `since` is UNKNOWN and says so: the last tick's time is never read as the first", () => {
  const r = reading(refusing(60, { since: null }));
  assert.equal(r.status, "unknown");
  assert.match(r.detail, /no `since`/);
});

test("a refusal that began after its own last tick is UNKNOWN", () => {
  const r = reading(refusing(0, { since: NOW + MINUTE_MS }));
  assert.equal(r.status, "unknown");
  assert.match(r.detail, /after its last tick/);
});

// --- the file: absent, malformed, and a real one --------------------------------------------------------------------------------------

test("parsing: absent, not JSON, not an object, not `{ readAt, record }` and a half-written refusal are each unreadable with a reason; an empty record and a null refusal are read", () => {
  const p = "runs/fleet-auto-off-mirror.json";
  for (const [text, why] of [[null, /could not be read/], ["{not json", /is not JSON/], ["[]", /not `\{ readAt, record \}`/], ["null", /not `\{ readAt, record \}`/],
    [JSON.stringify({ refusal: null }), /not `\{ readAt, record \}`/],
    [mirrorText({}, "now"), /not `\{ readAt, record \}`/],
    [mirrorText("{}"), /not `\{ readAt, record \}`/],
    [mirrorText([]), /not `\{ readAt, record \}`/],
    [mirrorText({ refusal: { reason: "stale-checkout" } }), /without a reason, a detail and a time/],
    [mirrorText({ refusal: { reason: "x", detail: "y", at: "now" } }), /without a reason, a detail and a time/],
    [mirrorText({ refusal: { reason: "x", detail: "y", at: 1, since: "then" } }), /without a reason, a detail and a time/]] as const) {
    const fact = parseAutoOffMirror(text, p);
    assert.ok("unreadable" in fact, `${String(text)} must be unreadable`);
    assert.match(fact.unreadable, why);
  }
  assert.deepEqual(parseAutoOffMirror(mirrorText({}), p), { refusal: null, readAt: READ_AT }, "a control plane with no state file is mirrored as `{}`");
  assert.deepEqual(parseAutoOffMirror(mirrorText({ idleSince: {}, refusal: null }), p), { refusal: null, readAt: READ_AT });
  assert.deepEqual(parseAutoOffMirror(mirrorText({ refusal: { reason: "cannot-tell", detail: "d", at: 5 } }), p),
    { refusal: { reason: "cannot-tell", detail: "d", at: 5, since: null }, readAt: READ_AT });
  assert.deepEqual(parseAutoOffMirror(mirrorText({ refusal: { reason: "cannot-tell", detail: "d", at: 5, since: 2 } }), p),
    { refusal: { reason: "cannot-tell", detail: "d", at: 5, since: 2 }, readAt: READ_AT });
});

test("reading the real path: a mirror written to `runs/fleet-auto-off-mirror.json` under the root trips, an absent file is unknown, and the old state file is not read", () => {
  const root = mkdtempSync(join(tmpdir(), "auto-off-refusal-"));
  try {
    const absent = readAutoOffRefusal({ root });
    assert.ok("unreadable" in absent);
    assert.match(absent.unreadable, /fleet-auto-off-mirror\.json/);
    assert.equal(reading(absent).status, "unknown");
    mkdirSync(join(root, "runs"));
    const record = { idleSince: {}, shutdownRequestedAt: {}, fetchedAt: null, refusal: refusing(16).refusal };
    writeFileSync(join(root, "runs/fleet-auto-off-state.json"), JSON.stringify(record));
    assert.equal(reading(readAutoOffRefusal({ root })).status, "unknown", "the control plane's own path is not the mirror: a leftover copy of it is never read");
    writeFileSync(join(root, AUTO_OFF_MIRROR_PATH), mirrorText(record));
    assert.equal(reading(readAutoOffRefusal({ root })).status, "tripped");
    writeFileSync(join(root, AUTO_OFF_MIRROR_PATH), mirrorText({ ...record, refusal: null }));
    assert.equal(reading(readAutoOffRefusal({ root })).status, "clear");
    writeFileSync(join(root, AUTO_OFF_MIRROR_PATH), mirrorText(record, NOW - 3 * 60 * MINUTE_MS));
    assert.equal(reading(readAutoOffRefusal({ root })).status, "unknown", "a mirror three hours old is a watcher that did not look");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the tick: the signal is in SIGNALS, in the order, and in the log when unknown ---------------------------------------------------

const QUIET = { now: NOW, lastMergedAt: NOW - 60 * MINUTE_MS, work: { greenPrs: 0, claimableRows: 0 }, redPrs: [], refusals: {},
  drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null };
/** An extracted tool's tree: a copy with no original, which `orgHealthTick` leaves out rather than stating unknown, so the copies are neither tripped nor unknown here. */
const noCopies = () => [{ original: "a.mjs", copy: "b.mjs", originalText: null, copyText: "", allowedLines: 0 }];

test("the readings carry the signal only when the fact is given, and the order names the signal, the reason, the age and the bound", () => {
  assert.equal(orgHealthReadings(QUIET as never).some((r) => r.signal === SIGNAL), false);
  const readings = orgHealthReadings({ ...QUIET, autoOff: refusing(16) } as never);
  const orders = orgHealthOrders(readings);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].subject, SIGNAL);
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /ORG HEALTH: `fleet-auto-off-refusing` HAS TRIPPED\./);
  assert.match(orders[0].prompt, /stale-checkout/);
  assert.match(orders[0].prompt, /16 min/);
  assert.match(orders[0].prompt, /It first tripped at 2026-10-06T16:59:/);
  assert.match(orders[0].prompt, /orchestrator/);
  assert.match(orders[0].prompt, /DO NOT RUN `fleet:\*`/);
});

test("the tick reads the record itself when the caller gives none: a standing refusal is offered, a record that cannot be read is said on stderr", () => {
  const said: string[] = [];
  const offered = orgHealthTick(QUIET as never, { log: (l) => said.push(l), readCopies: noCopies, readAutoOff: () => refusing(16) as never });
  assert.deepEqual(offered.map((o) => o.subject), [SIGNAL]);
  assert.deepEqual(said, [], "a tripped signal's report is its order, and a line written every tick would be offered as a fault of its own");

  const unread: string[] = [];
  const none = orgHealthTick(QUIET as never, { log: (l) => unread.push(l), readCopies: noCopies, readAutoOff: () => ({ unreadable: "the mirror is gone" }) });
  assert.deepEqual(none, []);
  assert.match(unread.join(""), /org-health: fleet-auto-off-refusing UNKNOWN -- the mirror is gone; it is not read as clear\./);
});

test("a caller's own `autoOff` fact wins over the reader, which is not asked", () => {
  const orders = orgHealthTick({ ...QUIET, autoOff: { refusal: null, readAt: READ_AT } } as never,
    { log: () => undefined, readCopies: noCopies, readAutoOff: () => { throw new Error("must not be asked"); } });
  assert.deepEqual(orders, []);
});
