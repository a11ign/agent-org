// no-token: pure -- the reading is a function of values handed in; the one disk read (`readClaimRefusals`) is given a real temporary file, and nothing here calls `gh`, ssh or the fleet.
/**
 * `src/org-health.ts`, agent-org#889 (a11ign/agent-org#885 class 2): A CLAIM-REFUSAL STORM IS RAISED, naming the most frequent reason.
 *
 * THE THRESHOLDS ARE WRITTEN OUT HERE (more than 10 refusals, in 15 minutes), NEVER AS THE EXPORTS: a test built from the constant moves with it (`org-health.test.ts`'s rule). Every
 * time is built from `NOW` and a number of minutes, so a boundary is a boundary and not a coincidence of the clock.
 *
 * POSITIVE CONTROLS. Eleven refusals inside the window TRIP and ten do not, from the same builder, so every "does not trip" is only worth something because that one does; the
 * file read is controlled by a ledger written to a real temporary directory and read back through the real path. MUTATIONS, each run by hand and recorded on the row: never trip
 * (the eleven test goes red), always trip (the ten, the stale and the unknown tests go red), count `>= 10` for `> 10` (the ten test goes red), drop the window (the stale test goes
 * red), and name the first reason seen for the commonest (the commonest test goes red).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health.test.ts`'s #3233 rule, in short): `org-health.ts` resolves the checkout it serves when it is imported, and with no
// `$AGENT_ORG_HOST` that is wherever the suite happens to be run from, which refuses. The host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "claim-refusal-storm-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { SIGNALS } = await import("./org-health/thresholds.ts");
const { CLAIM_REFUSED_KIND } = await import("./failure-ledger.ts");
const { claimRefusalStormReading, readClaimRefusals } = await import("./org-health/claim-and-tick-readings.ts");
const { orgHealthReadings, orgHealthOrders, orgHealthTick } = await import("./org-health/fleet-build-readings.ts");

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-11T09:15:00Z");
const STALE = "COULD NOT DETERMINE: THIS CHECKOUT'S COPY OF THE RULE IS 1 COMMIT(S) BEHIND THE RELEASE THE HOST RUNS (v0.154.11).";
const TAKEN = "NOT CLAIMED: #12 is already claimed by worker-12.";

/** `count` refusals of one reason, one minute apart ending `endMinutesAgo` before `NOW`. */
const refusals = (count: number, reason: string, endMinutesAgo = 0) =>
  Array.from({ length: count }, (_, i) => ({ at: NOW - (endMinutesAgo + i) * MINUTE, reason }));

test("11 refusals inside 15 minutes TRIP and name the commonest reason with its count", () => {
  const reading = claimRefusalStormReading({ now: NOW, refusals: [...refusals(8, STALE), ...refusals(3, TAKEN, 8)] });
  assert.equal(reading.status, "tripped", "POSITIVE CONTROL: this is the storm, and it is reachable");
  assert.equal(reading.signal, "claim-refusal-storm");
  assert.match(reading.detail, /11 claims were refused in the last 15 min/);
  assert.ok(reading.detail.includes(`8 of them: ${JSON.stringify(STALE)}`), `the commonest reason, quoted, with how many gave it: ${reading.detail}`);
  assert.ok(!reading.detail.includes("already claimed"), "and not the rarer one");
});

test("10 refusals inside 15 minutes do NOT trip", () => {
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: refusals(10, STALE) }).status, "clear");
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: [] }).status, "clear");
});

test("the window is 15 minutes, inclusive: a refusal 15 min old counts, one a millisecond older does not", () => {
  const edge = (age: number) => [...refusals(10, STALE, 1), { at: NOW - age, reason: STALE }];
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: edge(15 * MINUTE) }).status, "tripped", "exactly 15 minutes is inside");
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: edge(15 * MINUTE + 1) }).status, "clear", "a millisecond more is not");
});

test("refusals older than the window are not a storm however many there are", () => {
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: refusals(163, STALE, 16) }).status, "clear");
});

test("the commonest reason is the one named, wherever it sits in the ledger, and a tie is broken by the text", () => {
  const taken = refusals(6, TAKEN);
  const stale = refusals(7, STALE, 6);
  assert.ok(claimRefusalStormReading({ now: NOW, refusals: [...taken, ...stale] }).detail.includes(`7 of them: ${JSON.stringify(STALE)}`));
  assert.ok(claimRefusalStormReading({ now: NOW, refusals: [...stale, ...taken] }).detail.includes(`7 of them: ${JSON.stringify(STALE)}`), "order of the ledger changes nothing");
  const tie = claimRefusalStormReading({ now: NOW, refusals: [...refusals(6, "b: second", 0), ...refusals(6, "a: first", 6)] });
  assert.ok(tie.detail.includes(`6 of them: "a: first"`), "a tie goes to the reason that sorts first, so the same ledger names the same reason every tick");
});

test("one storm is one signal and a storm with another cause is another", () => {
  const a = claimRefusalStormReading({ now: NOW, refusals: refusals(11, STALE) });
  const later = claimRefusalStormReading({ now: NOW + 3 * MINUTE, refusals: [...refusals(11, STALE), ...refusals(2, STALE, -3)] });
  const other = claimRefusalStormReading({ now: NOW, refusals: refusals(11, TAKEN) });
  assert.equal(a.discriminator, later.discriminator, "the same cause across ticks is one order");
  assert.notEqual(a.discriminator, other.discriminator);
});

test("it says when the storm began: the refusal that made it eleven", () => {
  const reading = claimRefusalStormReading({ now: NOW, refusals: refusals(11, STALE) });
  assert.equal(reading.firstTrippedAt, NOW - 0 * MINUTE, "refusals sit at NOW-10 ... NOW; the eleventh in time order is NOW");
});

test("a ledger that could not be read is an UNKNOWN, never a clear", () => {
  const reading = claimRefusalStormReading({ now: NOW, refusals: null });
  assert.equal(reading.status, "unknown");
  assert.match(reading.detail, /could not be read/);
});

// --- the ledger read ---

const ledger = (lines: string[]) => {
  const path = join(SCRATCH, `ledger-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
};

test("readClaimRefusals keeps the claim-refused lines of the failure ledger and no other kind", () => {
  const path = ledger([`${CLAIM_REFUSED_KIND}\t${NOW}\t${STALE}`, `main-red\t${NOW}\trun-1`, `${CLAIM_REFUSED_KIND}\t${NOW - MINUTE}\t${TAKEN}`]);
  assert.deepEqual(readClaimRefusals({ path }), [{ at: NOW, reason: STALE }, { at: NOW - MINUTE, reason: TAKEN }]);
});

test("a ledger that is absent is no refusals; one that cannot be parsed or read is null", () => {
  assert.deepEqual(readClaimRefusals({ path: join(SCRATCH, "no-such-ledger") }), [], "nothing wrote one: a host that has refused no claim");
  assert.equal(readClaimRefusals({ path: ledger(["not a ledger line"]) }), null, "a line read wrong is a storm drawn wrong");
  assert.equal(readClaimRefusals({ path: SCRATCH }), null, "a directory is not a ledger, and EISDIR is not ENOENT");
});

test("the real ledger through the real path: a written storm trips, ten written lines do not", () => {
  const eleven = ledger(Array.from({ length: 11 }, (_, i) => `${CLAIM_REFUSED_KIND}\t${NOW - i * MINUTE}\t${STALE}`));
  const ten = ledger(Array.from({ length: 10 }, (_, i) => `${CLAIM_REFUSED_KIND}\t${NOW - i * MINUTE}\t${STALE}`));
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: readClaimRefusals({ path: eleven }) }).status, "tripped");
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: readClaimRefusals({ path: ten }) }).status, "clear");
});

// --- the wiring ---

test("the tick reads the ledger itself, orders ceo with the reason, and the prompt carries a remedy", () => {
  const facts = { now: NOW, lastMergedAt: NOW - MINUTE, work: { greenPrs: 0, claimableRows: 0 }, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null };
  const orders = orgHealthTick(facts, { log: () => {}, readCopies: () => null, readAutoOff: () => ({ refusal: null, readAt: NOW }), readRefusals: () => refusals(11, STALE) });
  const storm = orders.filter((order) => order.subject === SIGNALS.CLAIM_REFUSAL_STORM);
  assert.deepEqual(storm.map((order) => order.session), ["ceo"]);
  assert.match(storm[0].prompt, /COULD NOT DETERMINE: THIS CHECKOUT'S COPY OF THE RULE/);
  assert.doesNotMatch(storm[0].prompt, /undefined/, "every signal has its remedy");
  assert.match(storm[0].prompt, /READ IT FIRST/);

  const quiet = orgHealthTick(facts, { log: () => {}, readCopies: () => null, readAutoOff: () => ({ refusal: null, readAt: NOW }), readRefusals: () => refusals(10, STALE) });
  assert.deepEqual(quiet.filter((order) => order.subject === SIGNALS.CLAIM_REFUSAL_STORM), []);
});

test("a caller that does not ask gets no reading, and one that asks with null gets an unknown", () => {
  const base = { now: NOW, lastMergedAt: NOW - MINUTE, work: { greenPrs: 0, claimableRows: 0 }, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null };
  assert.equal(orgHealthReadings(base).some((r) => r.signal === SIGNALS.CLAIM_REFUSAL_STORM), false);
  assert.equal(orgHealthReadings({ ...base, claimRefusals: null }).find((r) => r.signal === SIGNALS.CLAIM_REFUSAL_STORM)?.status, "unknown");
  assert.deepEqual(orgHealthOrders(orgHealthReadings({ ...base, claimRefusals: null })).filter((o) => o.subject === SIGNALS.CLAIM_REFUSAL_STORM), []);
});
