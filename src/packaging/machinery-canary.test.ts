// no-token: gh -- `main` and `machineryCanaryNow` are handed `run`/`git`/`io` seams; the state directory is a throwaway one; nothing reaches GitHub, git or herdr
/**
 * a11ign#5100: A MACHINERY CHANGE SHIPS BEHIND A FLAG THE GATE WATCHES FOR AN HOUR, AND EVERY SUPPRESSION FAILS OPEN IN FIFTEEN MINUTES.
 *
 * THE DEFECT, 2026-10-11: four of the day's regressions were fixes to the org's own machinery that were green in tests and broken live, and found by the chairman rather than by a signal.
 * The row's four tests, each reached from the call the gate (or `pr:open`) makes and not from a helper:
 *   (1) a flagged change whose canary hour doubles `claims-refused` is reverted: the flag off, an incident carrying BOTH readings, an order to `ceo`;
 *   (2) a clean canary leaves the flag on and ends PASSED, and a signal the tick could not read is UNKNOWN, never clean;
 *   (3) a held order older than 15 minutes is delivered to its holder with the reason and the original order, unless a claimed row is working it;
 *   (4) `pr:open` refuses a machinery change with no `Flag:`, `Health-signals:` or `Revert:` line, and passes a whole one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { ACCOUNT_LIMIT_FILE, ACCOUNT_LIMIT_FLAG } from "../account-limit.ts";
import { CANARY_STATE_FILE } from "../org-health/claim-refusal.ts";
import { DEFAULT_CANARY_OPTIONS, expireSuppressions, machineryCanaryTick, parseCanaryOptions, withMachineryFlag, machineryValues, type CanaryFacts, type CanaryIo, type Suppression } from "../org-health.ts";
import { MACHINERY_SIGNALS } from "../org-health/hold-count.ts";
import { UNSOURCED_MACHINERY_SIGNALS, machineryFlagOn, parseCanaryState, emptyCanaryState } from "../org-health/fleet-build-readings.ts";
import { EXIT_NOTHING_SENT, machineryDeclarationProblems, machineryFilesIn, machineryRefusal, main } from "../pr-open.ts";
import { cannotAskExit, tickLanes } from "../work-gate.ts";
import { deferredWakeCount, incidentSuppressions, machineryCanaryNow } from "../work-gate/causes/org-health-github-incident.ts";
import { EXIT } from "../work-gate/reads/read-memo-and-exit.ts";
import { pacedUnread } from "../work-gate/pacing.ts";
import { workGateSource } from "../lib/work-gate-source.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-11T12:00:00Z");
const FLAG = "claim-offer-order";
const OPTIONS = { ...DEFAULT_CANARY_OPTIONS };

/** A tick's facts: `refusals` claim refusals at the given times (ms), every other signal read as `0`/none unless overridden. */
const facts = (over: Partial<CanaryFacts> & { refusalsAt?: number[] } = {}): CanaryFacts => ({
  claimRefusals: (over.refusalsAt ?? []).map((at) => ({ at, reason: "B4: the row's Region is held by another claim" })),
  unread: [], deferredWakes: 0, unarmed: [], releaseRuns: { runs: [] } as any, ...over,
});

/** The IO of a tick on a state held in memory; `filed` collects incidents, `logs` what it said. */
function memoryIo(initial: string | null = null, { refuseIncident = false }: { refuseIncident?: boolean } = {}) {
  const store = { text: initial };
  const filed: { title: string; body: string }[] = [];
  const logs: string[] = [];
  const io: CanaryIo = {
    read: () => store.text,
    write: (_path, text) => { store.text = text; },
    fileIncident: (title, body) => {
      if (refuseIncident) throw new Error("gh: HTTP 502");
      filed.push({ title, body });
      return `https://github.com/a11ign/a11ign/issues/${9000 + filed.length}`;
    },
    log: (line) => { logs.push(line); },
  };
  return { io, store, filed, logs, state: () => parseCanaryState(store.text) };
}

/** One tick `minutes` after T0. */
const tickAt = (h: ReturnType<typeof memoryIo>, minutes: number, f: CanaryFacts, suppressed: Suppression[] = []) =>
  machineryCanaryTick({ now: T0 + minutes * MINUTE, facts: f, suppressed, dir: "/state", options: OPTIONS, io: h.io });

/** The hour before the flag: a tick every 10 minutes from -60 to 0 with `perTick` refusals each, then the flag is turned on, and its first tick starts the hour. */
function withHourBefore({ perTick }: { perTick: number }) {
  const h = memoryIo();
  const refusals: number[] = [];
  for (let minute = -60; minute <= -10; minute += 10) {
    for (let i = 0; i < perTick; i += 1) refusals.push(T0 + (minute + 5) * MINUTE);
    tickAt(h, minute + 10, facts({ refusalsAt: [...refusals] }));
  }
  h.store.text = JSON.stringify(withMachineryFlag(h.state(), { name: FLAG, on: true, signals: [MACHINERY_SIGNALS.CLAIMS_REFUSED, MACHINERY_SIGNALS.BLIND_TICKS] }));
  tickAt(h, 0, facts({ refusalsAt: [...refusals] })); // the tick that finds the flag on starts the hour
  return { h, refusals };
}

test("#5100 (1) DOUBLED CLAIMS REFUSED: a flagged change whose hour doubles `claims-refused` is turned OFF, with an incident carrying both readings and an order to ceo", () => {
  const { h, refusals } = withHourBefore({ perTick: 1 }); // 6 refusals in the hour before
  assert.equal(h.state().flags[FLAG].verdict, "watching");
  assert.equal(machineryFlagOn(h.state(), FLAG), true, "the hour has begun with the flag on");

  const after = [...refusals];
  let orders: Record<string, any>[] = [];
  for (let minute = 10; minute <= 40; minute += 10) {
    for (let i = 0; i < 4; i += 1) after.push(T0 + (minute - 5) * MINUTE); // 4 a tick: 12 by minute 30, twice the hour before
    orders = tickAt(h, minute, facts({ refusalsAt: [...after] }));
    if (!machineryFlagOn(h.state(), FLAG)) break;
  }

  const record = h.state().flags[FLAG];
  assert.equal(record.on, false, "THE FLAG IS OFF: the machinery reads as it did before the change");
  assert.equal(record.verdict, "reverted");
  assert.equal(h.filed.length, 1, "ONE incident, not one a tick");
  assert.match(h.filed[0].body, /claims-refused/);
  assert.match(h.filed[0].body, /6 in the hour before/, "the reading BEFORE is in the incident");
  assert.match(h.filed[0].body, /since \(\d+ min\)/, "and the reading AFTER");
  const order = orders.find((candidate) => candidate.cause === "org-health" && candidate.subject === "machinery-canary");
  assert.ok(order, "ceo is woken");
  assert.equal(order.session, "ceo");
  assert.match(order.prompt, /9001/, "the order names the incident");
  assert.match(order.prompt, /claims-refused/);
  assert.ok(record.decidedAt !== null && record.decidedAt - (record.onAt as number) < 60 * MINUTE, "the revert did not wait for the hour: counts only grow");
});

test("#5100 (1b) A REFUSED INCIDENT FILING IS RETRIED NEXT TICK and the order says so; the flag is off either way", () => {
  const { h, refusals } = withHourBefore({ perTick: 1 });
  const flood = [...refusals, ...Array.from({ length: 12 }, () => T0 + 5 * MINUTE)];
  const refusing = memoryIo(h.store.text, { refuseIncident: true });
  const first = machineryCanaryTick({ now: T0 + 10 * MINUTE, facts: facts({ refusalsAt: flood }), dir: "/state", options: OPTIONS, io: refusing.io });
  assert.equal(refusing.state().flags[FLAG].on, false);
  assert.equal(refusing.state().flags[FLAG].incident, "unfiled");
  assert.match(first.find((order) => order.cause === "org-health" && order.subject === "machinery-canary")?.prompt, /could not be filed this tick and is retried/);
  assert.match(refusing.logs.join(""), /could not file the incident/);

  const second = machineryCanaryTick({ now: T0 + 20 * MINUTE, facts: facts({ refusalsAt: flood }), dir: "/state", options: OPTIONS, io: h.io /* the filer works now */ });
  assert.equal(second.some((order) => order.cause === "org-health" && order.subject === "machinery-canary"), true);
});

test("#5100 (2) A CLEAN CANARY LEAVES THE FLAG ON: a steady hour is PASSED, and nothing is filed", () => {
  const { h, refusals } = withHourBefore({ perTick: 1 });
  const after = [...refusals];
  let last: Record<string, any>[] = [];
  for (let minute = 10; minute <= 60; minute += 10) {
    after.push(T0 + (minute - 5) * MINUTE); // the same rate as the hour before
    last = tickAt(h, minute, facts({ refusalsAt: [...after] }));
  }
  const record = h.state().flags[FLAG];
  assert.equal(record.on, true, "THE FLAG STAYS ON");
  assert.equal(record.verdict, "passed");
  assert.deepEqual(h.filed, [], "no incident");
  assert.deepEqual(last.filter((order) => order.cause === "org-health" && order.subject === "machinery-canary"), [], "and no order to ceo");
});

test("#5100 (2b) A SIGNAL THE TICK COULD NOT READ IS UNKNOWN, NOT CLEAN: a flag that names only an unsourced signal is not PASSED on it", () => {
  assert.deepEqual([...UNSOURCED_MACHINERY_SIGNALS].sort(), [MACHINERY_SIGNALS.INCIDENTS_NOT_REAL, MACHINERY_SIGNALS.RATE_LIMIT_REFUSALS].sort());
  const h = memoryIo();
  for (let minute = -60; minute <= 0; minute += 10) tickAt(h, minute, facts());
  h.store.text = JSON.stringify(withMachineryFlag(h.state(), { name: "unsourced", on: true, signals: [MACHINERY_SIGNALS.RATE_LIMIT_REFUSALS] }));
  for (let minute = 0; minute <= 60; minute += 10) tickAt(h, minute, facts());
  const record = h.state().flags.unsourced;
  assert.equal(record.readings[0].status, "unknown", "no source reads it, so it is neither clean nor degraded");
  assert.equal(record.on, true, "and an unknown reading does not turn a flag off");
});

test("#5100 (2c) A BASELINE FROM TEN MINUTES IS NOT A BASELINE: a flag turned on at the gate's first tick is UNKNOWN, and a burst after it is not read against nothing", () => {
  const h = memoryIo();
  h.store.text = JSON.stringify(withMachineryFlag(emptyCanaryState(), { name: FLAG, on: true, signals: [MACHINERY_SIGNALS.CLAIMS_REFUSED] }));
  // The first tick backfills one window from the log it is handed, so give it a log that dates ONLY the last ten minutes: the hour is not covered by what was recorded.
  tickAt(h, 0, facts());
  tickAt(h, 10, facts({ refusalsAt: Array.from({ length: 20 }, () => T0 + 5 * MINUTE) }));
  const reading = h.state().flags[FLAG].readings[0];
  assert.equal(h.state().samples.length, 2);
  assert.ok(reading.status === "unknown" || reading.status === "degraded", `a reading is never silently clean without a baseline: ${reading.status}`);
});

/** a11ign#5497: the gate's account record, held until `until` (ms), as `pausedNow` reads it from `dir`. */
const writePause = (dir: string, until: number) =>
  writeFileSync(join(dir, ACCOUNT_LIMIT_FILE), JSON.stringify({ [homedir()]: { limitedUntil: until, seenOn: "2026-10-15", text: "usage limit reached" } }));

/** Ticks the quiet hour before T0, then turns the `wakes-held` reading on in the flag and takes the tick that starts the hour. */
function watchWakesHeld(h: ReturnType<typeof memoryIo>, tickWith: (minute: number, deferredWakes: number) => unknown) {
  for (let minute = -60; minute <= -10; minute += 10) tickWith(minute, 0);
  h.store.text = JSON.stringify(withMachineryFlag(h.state(), { name: FLAG, on: true, signals: [MACHINERY_SIGNALS.WAKES_HELD] }));
  tickWith(0, 0); // the tick that finds the flag on starts the hour
}

/**
 * a11ign#5497: `wakes-held` on a flag turned on at T0. The account pause is recorded over the hour before it (`pausedBefore`), so every tick there is HELD; then the flag is on and
 * `wakes-held` reads 23 in its first ten minutes, which is the surge the first hour after a pause read as a regression.
 */
function wakesHeldCanary({ pausedBefore }: { pausedBefore: boolean; }) {
  const dir = tmpDir("machinery-canary-");
  const h = memoryIo(JSON.stringify(withMachineryFlag(emptyCanaryState(), { name: ACCOUNT_LIMIT_FLAG, on: true, signals: [] })));
  if (pausedBefore) writePause(dir, T0 - 5 * MINUTE); // holds the ticks up to minute -10, lifted by minute 0
  const tickWith = (minute: number, deferredWakes: number) => machineryCanaryTick({ now: T0 + minute * MINUTE, facts: facts({ deferredWakes }), dir, options: OPTIONS, io: h.io });
  watchWakesHeld(h, tickWith);
  tickWith(10, 23);
  for (let minute = 20; minute <= 60 && machineryFlagOn(h.state(), FLAG); minute += 10) tickWith(minute, 0);
  return h;
}

test("#5497 (1) A HELD HOUR IS NO BASELINE: the first hour after an account pause does not revert a flag on a steady stock; it reads UNKNOWN and stays ON, and is not PASSED", () => {
  const h = wakesHeldCanary({ pausedBefore: true });
  const record = h.state().flags[FLAG];
  assert.equal(record.readings[0].status, "unknown", "the hour before was a pause: not a baseline");
  assert.match(record.readings[0].detail, /not a baseline: the account pause held Claude work/);
  assert.equal(record.on, true, "THE FLAG STAYS ON");
  assert.equal(record.verdict, "watching", "an hour with nothing read is not PASSED either");
  assert.deepEqual(h.filed, [], "no incident");
});

test("#5497 (1b) THE SAME NUMBERS WITH NO PAUSE ARE DEGRADED: a flag on a stock after a quiet hour is reverted (the positive control)", () => {
  const h = wakesHeldCanary({ pausedBefore: false });
  const record = h.state().flags[FLAG];
  assert.equal(record.readings[0].status, "degraded");
  assert.equal(record.on, false, "THE FLAG IS OFF");
  assert.equal(record.verdict, "reverted");
});

test("#5497 (1c) A PAUSE THAT BEGINS INSIDE THE HOUR AFTER THE FLAG IS ON IS READ: only the hour BEFORE is held, so the pause that starts after the switch is not unknown", () => {
  const dir = tmpDir("machinery-canary-");
  const h = memoryIo(JSON.stringify(withMachineryFlag(emptyCanaryState(), { name: ACCOUNT_LIMIT_FLAG, on: true, signals: [] })));
  const tickWith = (minute: number, deferredWakes: number) => machineryCanaryTick({ now: T0 + minute * MINUTE, facts: facts({ deferredWakes }), dir, options: OPTIONS, io: h.io });
  watchWakesHeld(h, tickWith);
  tickWith(10, 0);
  writePause(dir, T0 + 60 * MINUTE); // the pause begins after minute 10, inside the hour the flag now watches
  tickWith(20, 23);
  const record = h.state().flags[FLAG];
  assert.equal(record.readings[0].status, "degraded", "the before-hour was quiet and unheld, so it is a baseline");
  assert.equal(record.on, false);
  assert.equal(record.verdict, "reverted");
});

test("#5497 (1d) AN UNREADABLE ACCOUNT RECORD HOLDS THE HOUR, the gate's fail-closed rule: a sample taken while the file cannot be read is held, and a flag OFF holds nothing", () => {
  const dir = tmpDir("machinery-canary-");
  writeFileSync(join(dir, ACCOUNT_LIMIT_FILE), "{not json");
  const h = memoryIo(JSON.stringify(withMachineryFlag(emptyCanaryState(), { name: ACCOUNT_LIMIT_FLAG, on: true, signals: [] })));
  machineryCanaryTick({ now: T0, facts: facts(), dir, options: OPTIONS, io: h.io });
  assert.equal(h.state().samples.at(-1)?.held, true, "flag on, the record cannot be read: held");
  const off = memoryIo(JSON.stringify(emptyCanaryState()));
  machineryCanaryTick({ now: T0, facts: facts(), dir, options: OPTIONS, io: off.io });
  assert.deepEqual(off.state().samples.filter((sample) => sample.held), [], "flag off: no sample is held, whatever the file says");
});

test("#5100 (3) A HELD ORDER OLDER THAN 15 MINUTES IS DELIVERED, with the reason and the original order", () => {
  const original = { session: "worker-4401", cause: "pr-checks-failing", subject: "pr-4401", discriminator: "red", causeKey: "worker-4401/pr-checks-failing/pr-4401", prompt: "PR #4401 is red on `gate`; read the log." };
  const held: Suppression = { key: original.causeKey, kind: "hold", holder: "worker-4401", reason: "GitHub reports an incident and the runner never started", order: original, claimedRow: null };
  const h = memoryIo();

  assert.deepEqual(tickAt(h, 0, facts(), [held]).filter((order) => order.cause === "pr-checks-failing"), [], "first seen: kept back, the hold has not run its 15 minutes");
  assert.deepEqual(tickAt(h, 14, facts(), [held]).filter((order) => order.cause === "pr-checks-failing"), [], "14 minutes: still kept");
  const delivered = tickAt(h, 15, facts(), [held]).filter((order) => order.cause === "pr-checks-failing");
  assert.equal(delivered.length, 1, "15 minutes: DELIVERED");
  assert.equal(delivered[0].session, "worker-4401", "to its holder");
  assert.equal(delivered[0].causeKey, original.causeKey, "as the original order, so the waker's dedupe sees the same cause");
  assert.match(delivered[0].prompt, /A HOLD KEPT THIS FROM YOU FOR 15 MINUTES/);
  assert.match(delivered[0].prompt, /runner never started/, "with the reason");
  assert.match(delivered[0].prompt, /PR #4401 is red on `gate`; read the log\./, "and the original order, whole");
});

test("#5100 (3b) A CLAIMED ROW WORKING THE REASON EXCUSES THE HOLD, however long it stands; and a suppression that ENDS starts its clock again", () => {
  const held: Suppression = { key: "k", kind: "shelving", holder: "product-manager", reason: "shelved behind #4999", order: null, claimedRow: 4999 };
  const free = { ...held, claimedRow: null };
  const quiet = expireSuppressions({ suppressed: [held], memo: {}, now: T0, minutes: 15 });
  assert.deepEqual(expireSuppressions({ suppressed: [held], memo: quiet.memo, now: T0 + 6 * 60 * MINUTE, minutes: 15 }).released, [], "six hours, a claimed row: left");

  const first = expireSuppressions({ suppressed: [free], memo: {}, now: T0, minutes: 15 });
  const gone = expireSuppressions({ suppressed: [], memo: first.memo, now: T0 + 10 * MINUTE, minutes: 15 });
  assert.deepEqual(gone.memo, {}, "ended: forgotten");
  const back = expireSuppressions({ suppressed: [free], memo: gone.memo, now: T0 + 20 * MINUTE, minutes: 15 });
  assert.deepEqual(back.released, [], "it came back at minute 20 and is a NEW suppression");

  const orderless = expireSuppressions({ suppressed: [free], memo: first.memo, now: T0 + 15 * MINUTE, minutes: 15 }).released;
  assert.equal(orderless.length, 1);
  assert.equal(orderless[0].subject, "suppression-expired", "with no original order held, the holder is still woken with the reason");
  assert.equal(orderless[0].session, "product-manager");
});

test("#5100 (3c) THE GATE'S OWN HOLD IS THE SUPPRESSION: `incidentSuppressions` carries the held order, and `machineryCanaryNow` delivers it after 15 minutes", () => {
  const order = { session: "worker-7", cause: "pr-checks-failing", subject: "pr-77", discriminator: "d", causeKey: "worker-7/pr-checks-failing/pr-77", prompt: "red" };
  const [suppression] = incidentSuppressions([{ subject: "pr-77", session: "worker-7", why: "runner never started" }], [order, { ...order, session: "other" }]);
  assert.equal(suppression.order, order, "matched on session AND subject AND cause");
  assert.equal(suppression.claimedRow, null, "no row can be working a GitHub incident");

  const dir = tmpDir("machinery-canary-");
  const h = memoryIo();
  const run = () => "";
  const call = (nowMs: number) => machineryCanaryNow({ unread: [], unarmed: [], releaseRuns: { runs: [] } as any, suppressions: [suppression], now: nowMs, dir, run, io: h.io });
  assert.deepEqual(call(T0).filter((o) => o.cause === "pr-checks-failing"), []);
  assert.equal(call(T0 + 16 * MINUTE).filter((o) => o.cause === "pr-checks-failing").length, 1, "the gate's call delivers it");
});

test("#5100 (3d) THE WAKER'S DEFERRED COUNT IS THE `wakes-held` SIGNAL: an absent file is UNREAD (null), never zero", () => {
  assert.equal(deferredWakeCount("/state", () => { throw new Error("ENOENT"); }), null);
  assert.equal(deferredWakeCount("/state", () => "a\t1\n\nb\t2\n"), 2);
  assert.equal(deferredWakeCount("/state", () => ""), 0);
});

test("#5100 (5) THE OPTIONS: on by default, set by `machineryCanary` in host.json, and a mistyped one is a problem with the defaults standing", () => {
  assert.deepEqual(parseCanaryOptions(null), { options: DEFAULT_CANARY_OPTIONS, problem: null });
  assert.equal(DEFAULT_CANARY_OPTIONS.enabled, true, "ON BY DEFAULT");
  assert.equal(DEFAULT_CANARY_OPTIONS.windowMinutes, 60);
  assert.equal(DEFAULT_CANARY_OPTIONS.suppressionMinutes, 15);
  const set = parseCanaryOptions(JSON.stringify({ machineryCanary: { windowMinutes: 30, degradeFactor: 3, minRise: 5, suppressionMinutes: 10 } }));
  assert.equal(set.problem, null);
  assert.deepEqual(set.options, { enabled: true, windowMinutes: 30, degradeFactor: 3, minRise: 5, suppressionMinutes: 10 });
  assert.equal(parseCanaryOptions(JSON.stringify({ machineryCanary: { enabled: false } })).options.enabled, false, "and it can be turned off");
  for (const bad of [{ windowMinutes: "60" }, { windowMinutes: 1 }, { degradeFactor: 0 }, { thresold: 2 }, { enabled: "no" }]) {
    const read = parseCanaryOptions(JSON.stringify({ machineryCanary: bad }));
    assert.notEqual(read.problem, null, JSON.stringify(bad));
    assert.deepEqual(read.options, DEFAULT_CANARY_OPTIONS, "the defaults stand");
  }
  assert.notEqual(parseCanaryOptions("{not json").problem, null);
});

test("#5100 DISABLED: with the canary off the tick records nothing and orders nothing", () => {
  const h = memoryIo();
  const orders = machineryCanaryTick({ now: T0, facts: facts(), dir: "/state", options: { ...OPTIONS, enabled: false }, io: h.io });
  assert.deepEqual(orders, []);
  assert.equal(h.store.text, null, "no state written");
});

test("#5100 A STATE FILE THAT IS NOT THE SHAPE STOPS THE CANARY AND SAYS SO: the tick does not throw", () => {
  const h = memoryIo("{\"hello\": 1}");
  const orders = machineryCanaryTick({ now: T0, facts: facts(), dir: "/state", options: OPTIONS, io: h.io });
  assert.deepEqual(orders, []);
  assert.match(h.logs.join(""), /machinery-canary: could not run/);
  assert.equal(h.store.text, "{\"hello\": 1}", "and the file is left as it was, not overwritten with an empty one");
});

test("#5100 THE STATE LANDS IN THE STATE DIRECTORY through the real IO, whole", () => {
  const dir = tmpDir("machinery-canary-");
  machineryCanaryNow({ unread: [], unarmed: [], releaseRuns: null, now: T0, dir, run: () => "" });
  const state = parseCanaryState(readFileSync(join(dir, CANARY_STATE_FILE), "utf8"));
  assert.equal(state.samples.length, 1);
  assert.equal(state.samples[0].values[MACHINERY_SIGNALS.RELEASE_FAILURES], null, "a release read that was not made is null, not 0");
  assert.equal(state.samples[0].values[MACHINERY_SIGNALS.BLIND_TICKS], 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// (4) `pr:open`
// ---------------------------------------------------------------------------------------------------------------------

const ACCEPTANCE_FILE = ".acceptance/agent~x.md";
const WHOLE = ["Acceptance: node -e \"process.exit(0)\"", "Closes: none — a test", "Flag: claim-offer-order", "Health-signals: claims-refused, wakes-held", "Revert: turn the flag off, or revert this PR"].join("\n\n");

test("#5100 (4) `pr:open` REFUSES a machinery change with no flag, signal or revert line, naming each", () => {
  const diff = { ok: true as const, files: ["src/work-gate.ts", ACCEPTANCE_FILE] };
  const refused = machineryRefusal(diff, "Acceptance: true\n\nCloses: none — x");
  assert.ok(refused !== null);
  assert.match(refused, /src\/work-gate\.ts/);
  assert.match(refused, /`Flag: <name>` is missing/);
  assert.match(refused, /`Health-signals: .*` is missing/);
  assert.match(refused, /`Revert: <how it is undone>` is missing/);
  assert.match(refused, /Nothing was sent/);

  assert.equal(machineryRefusal(diff, WHOLE), null, "POSITIVE CONTROL: the same diff with the three lines goes on");
});

test("#5100 (4b) THE DECLARATION'S EDGES: `Flag: none` needs a reason, signals come from the standard list and at most three, tests and docs are not machinery", () => {
  assert.deepEqual(machineryDeclarationProblems(WHOLE), []);
  assert.deepEqual(machineryDeclarationProblems(WHOLE.replace("Flag: claim-offer-order", "Flag: none -- the old behaviour is the defect")), []);
  assert.match(machineryDeclarationProblems(WHOLE.replace("Flag: claim-offer-order", "Flag: none"))[0], /needs its reason/);
  assert.match(machineryDeclarationProblems(WHOLE.replace("claims-refused, wakes-held", "claims-refused, my-own-metric"))[0], /my-own-metric/);
  assert.match(machineryDeclarationProblems(WHOLE.replace("claims-refused, wakes-held", "claims-refused, wakes-held, blind-ticks, release-failures"))[0], /names 4/);

  assert.deepEqual(machineryFilesIn(["src/work-gate.test.ts", "docs/a.md", ".changeset/x.md", ".acceptance/a.md", "src/packaging/machinery-canary.test.ts"]), [], "tests, docs, changesets and acceptance records are not machinery");
  assert.deepEqual(machineryFilesIn(["src/work-gate/org-health.ts", "src/claim-offer.ts", "src/wake.ts", "src/arm-pr.ts", "src/release-pr.ts"]).length, 5);
  assert.deepEqual(machineryFilesIn(["src/org-health.ts", "src/pr-open.ts", "src/org-health-release-failed.test.ts", "src/pr-open.test.ts", "src/org-health-other.ts"]), ["src/org-health.ts", "src/pr-open.ts"],
    "the canary and its own enforcement are machinery (their tests are not, and a sibling that merely shares the prefix is not)");
  assert.match(String(machineryRefusal({ ok: true, files: ["src/org-health.ts"] }, "no lines at all")), /Flag:/, "a change to the canary itself opens with the three lines, as any machinery change does");
  assert.equal(machineryRefusal({ ok: true, files: ["docs/x.md", "src/board.ts"] }, "no lines at all"), null, "a change with no machinery in it is not asked");
  assert.equal(machineryRefusal({ ok: false, why: "git said: bad revision" }, "no lines at all"), null, "an unreadable diff is not a refusal");
});

/** `main create` from a fixture whose diff is `files`, through the real `main` and its seams: what `pr:open` does, not what a helper does. */
function open(files: string[], body: string) {
  const sent: string[][] = [];
  const err: string[] = [];
  const code = main(["create", "--head", "agent/x", "--body-file", "body.md", "--body", body], {
    run: (args: string[]) => { sent.push(args); },
    git: (args: string[]) => (args[0] === "diff" ? (args.includes("--diff-filter=A") ? ACCEPTANCE_FILE : files.join("\0")) : args.includes("--abbrev-ref") ? "agent/x" : "abc123"),
    readFile: () => body,
    prHead: () => ({ ref: "agent/x", oid: "abc123" }),
    runAcceptance: () => 0,
    runMutation: () => 0,
    owner: () => "ceo",
    out: () => {},
    err: (line: string) => { err.push(line); },
  } as any);
  return { code, sent, err: err.join("") };
}

test("#5100 (4c) THROUGH `main`: the machinery refusal is wired in, sends nothing, and is not raised for a diff with no machinery in it", () => {
  const refused = open(["src/work-gate.ts", ACCEPTANCE_FILE], "Acceptance: node -e \"process.exit(0)\"\n\nCloses: none — a test\n");
  assert.equal(refused.code, EXIT_NOTHING_SENT, refused.err);
  assert.match(refused.err, /touches the org's machinery/);
  assert.deepEqual(refused.sent, [], "nothing was sent to GitHub");

  const plain = open(["docs/readme-note.md", ACCEPTANCE_FILE], "Acceptance: node -e \"process.exit(0)\"\n\nCloses: none — a test\n");
  assert.doesNotMatch(plain.err, /touches the org's machinery/, "POSITIVE CONTROL: the same body for a docs change is not asked for a flag");
});

test("#5100 THE FLAG IS OFF UNTIL SOMEBODY TURNS IT ON: an absent record reads off, and turning it on records no `onAt` until the gate's tick finds it", () => {
  const state = emptyCanaryState();
  assert.equal(machineryFlagOn(state, FLAG), false, "DEFAULT OFF");
  const on = withMachineryFlag(state, { name: FLAG, on: true });
  assert.equal(machineryFlagOn(on, FLAG), true);
  assert.equal(on.flags[FLAG].onAt, null, "the hour begins at the gate's next tick, which is the tick that can sample");
  assert.equal(machineryFlagOn(withMachineryFlag(on, { name: FLAG, on: false }), FLAG), false);
});

test("#5100 THE TICK CALLS IT: the gate's `main` takes the canary's orders from `tickLanes`, once, after the hold holders (a SOURCE pin on placement only: `main` is not driven whole by any test, and the seam's behaviour is pinned below)", () => {
  const source = workGateSource();
  const calls = source.match(/const lanes = tickLanes\(/g) ?? [];
  assert.equal(calls.length, 1, "one call per tick: a second would sample twice and double every count");
  assert.ok(source.indexOf("holdHolderOrdersNow({") < source.indexOf("const lanes = tickLanes("), "after the hold holders, before the dead man's switch");
  assert.equal(source.match(/orders\.push\(\.\.\.lanes\.orders\)/g)?.length ?? 0, 1, "and the orders go in once");
});

/** One tick's lanes, read through the seam `main` uses: the `blind-ticks` the canary sampled, and the lanes PARTIAL names. */
const sampledTick = (lanes: { prs: any[] | null; readyRows: any[] | null; others: { refused: string[]; }[]; pacedSkips: { refused: string[]; }[]; }) => {
  const h = memoryIo();
  const { unread } = tickLanes({ ...lanes, unarmed: [], releaseRuns: null, run: () => "", now: T0, dir: "/state", io: h.io });
  return { blind: h.state().samples[0].values[MACHINERY_SIGNALS.BLIND_TICKS], unread };
};

test("#1329 A REFUSED LANE IS BLIND, AND A PACED ONE IS NOT: a refused pull-request list, Ready rows or other repository samples `blind-ticks` as 1; a repository the gate paced out samples 0 and is still named on PARTIAL", () => {
  const refusedPulls = sampledTick({ prs: null, readyRows: [], others: [], pacedSkips: [] });
  assert.equal(refusedPulls.blind, 1, "the pull-request list was refused");
  assert.deepEqual(refusedPulls.unread, ["the pull-request list"], "and PARTIAL names it");
  assert.equal(sampledTick({ prs: [], readyRows: null, others: [], pacedSkips: [] }).blind, 1, "the Ready rows were refused");
  assert.equal(sampledTick({ prs: [], readyRows: [], others: [{ refused: ["the other repositories' lanes"] }], pacedSkips: [] }).blind, 1, "another repository's read was refused");

  // a paced tick: both primary lanes read, and the pool's reserve paced the repositories out
  const paced = [{ refused: pacedUnread({ paced: true, belowFloor: true, remaining: 10 }, { others: true }) }];
  const pacedTick = sampledTick({ prs: [], readyRows: [], others: [], pacedSkips: paced });
  assert.equal(pacedTick.blind, 0, "skipped by design is not blind");
  assert.deepEqual(pacedTick.unread, paced.flatMap((skip) => skip.refused), "PARTIAL still names the paced lanes, so they are never reported clean");
});

// ---------------------------------------------------------------------------------------------------------------------
// (6) #1332: a tick that could not read still owes the canary its sample
// ---------------------------------------------------------------------------------------------------------------------

/** Who the tick says it is, for the report `cannotAskExit` writes. */
const ACCOUNT = () => ({ login: "worker-agent-org-1332", source: "test" });

/** A tick whose two primary lanes were refused, through the seam `main` exits by: the one sample it owes the canary, and its report. */
const blindTick = (h: ReturnType<typeof memoryIo>, now: number, dir = "/state") => cannotAskExit({ prs: null, readyRows: null, identity: ACCOUNT, run: () => "", now, dir, io: h.io, write: () => {} });

test("#1332 (1) A CANNOT_ASK TICK RECORDS ONE BLIND SAMPLE AND EXITS CANNOT_ASK: both lanes refused reads `blind-ticks` 1 and says so on stderr; a tick that read a lane does neither", () => {
  const h = memoryIo();
  const said: string[] = [];
  const code = cannotAskExit({ prs: null, readyRows: null, identity: ACCOUNT, run: () => "", now: T0, dir: "/state", io: h.io, write: (text) => said.push(text) });
  assert.equal(code, EXIT.CANNOT_ASK, "the exit `main` takes");
  assert.match(said.join(""), /^CANNOT ASK: /, "the report says the tick examined nothing");
  assert.equal(h.state().samples.length, 1, "the one sample the exit owes the canary");
  assert.equal(h.state().samples[0].values[MACHINERY_SIGNALS.BLIND_TICKS], 1, "it was nothing before this change");

  const read = cannotAskExit({ prs: [], readyRows: null, identity: ACCOUNT, run: () => "", now: T0 + 10 * MINUTE, dir: "/state", io: h.io, write: (text) => said.push(text) });
  assert.equal(read, null, "a tick that read the pull-request list is not CANNOT_ASK");
  assert.equal(h.state().samples.length, 1, "and the exit records no sample for it");
  assert.equal(said.length, 1, "and says nothing");
});

test("#1332 (1b) `main` TAKES THE EXIT BEFORE IT READS THE REST (a SOURCE pin on placement only: `main` is not driven whole by any test; the exit's behaviour is pinned above)", () => {
  const source = workGateSource();
  const main = source.slice(source.indexOf("\nfunction main() {"));
  assert.ok(main.indexOf("cannotAskExit({") > 0, "`main` asks the seam");
  assert.ok(main.indexOf("cannotAskExit({") < main.indexOf("tickPacing()"), "before the pacing read, so a tick that could not read exits without reading more");
  assert.ok(main.includes("if (cannotAsk !== null) process.exit(cannotAsk);"), "and it exits with the code the seam returned");
});

test("#1332 (2) THE HELD-ORDER CLOCKS SURVIVE A TICK THAT ASKED NO SUPPRESSORS: a suppression first seen before a blind tick is delivered at fifteen minutes, not twenty", () => {
  const held: Suppression = { key: "k-1332", kind: "hold", holder: "worker-1332", reason: "GitHub reports an incident", order: null, claimedRow: null };
  const h = memoryIo();
  tickAt(h, 0, facts(), [held]);
  blindTick(h, T0 + 5 * MINUTE);
  assert.equal(h.state().memo[`held:${held.key}`], T0, "the clock is still there after the blind tick, and still reads from minute 0");

  const delivered = tickAt(h, 15, facts(), [held]).filter((order) => order.subject === "suppression-expired");
  assert.equal(delivered.length, 1, "DELIVERED at fifteen minutes");
});

test("#1332 (3) A REFUSED READ KEEPS THE APPROVED-UNQUEUED CLOCKS: a blind tick restarts neither the fifteen minutes nor the count", () => {
  const h = memoryIo();
  tickAt(h, 0, facts({ unarmed: [7] }));
  blindTick(h, T0 + 5 * MINUTE);
  assert.equal(h.state().memo["unarmed:7"], T0, "the clock of PR 7 is kept");

  tickAt(h, 20, facts({ unarmed: [7] }));
  assert.equal(h.state().samples.at(-1)?.values[MACHINERY_SIGNALS.APPROVED_UNQUEUED], 1, "PR 7 has been unqueued for twenty minutes, not restarted at the blind tick");
});

test("#1332 (4) THE THRESHOLD DURING A SHARED OUTAGE: an outage already running in the hour before is the baseline, so a flag switched on inside it is not reverted by it; a healthy hour then a sudden outage is", () => {
  const sustained = memoryIo();
  for (let minute = -60; minute <= -10; minute += 10) blindTick(sustained, T0 + minute * MINUTE);
  sustained.store.text = JSON.stringify(withMachineryFlag(sustained.state(), { name: FLAG, on: true, signals: [MACHINERY_SIGNALS.BLIND_TICKS] }));
  for (let minute = 0; minute <= 60; minute += 10) blindTick(sustained, T0 + minute * MINUTE);
  assert.equal(sustained.state().flags[FLAG].verdict, "passed", "the outage is in the baseline: six blind ticks against six is no rise");

  const sudden = memoryIo();
  for (let minute = -60; minute <= -10; minute += 10) tickAt(sudden, minute, facts());
  sudden.store.text = JSON.stringify(withMachineryFlag(sudden.state(), { name: FLAG, on: true, signals: [MACHINERY_SIGNALS.BLIND_TICKS] }));
  tickAt(sudden, 0, facts());
  for (let minute = 10; minute <= 30; minute += 10) blindTick(sudden, T0 + minute * MINUTE);
  assert.equal(sudden.state().flags[FLAG].verdict, "reverted", "a healthy hour then three blind ticks is a rise past the minimum");
});
