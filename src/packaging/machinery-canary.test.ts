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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import {
  CANARY_STATE_FILE, DEFAULT_CANARY_OPTIONS, MACHINERY_SIGNALS, UNSOURCED_MACHINERY_SIGNALS, expireSuppressions, machineryCanaryTick, machineryFlagOn, parseCanaryOptions,
  parseCanaryState, withMachineryFlag, emptyCanaryState, machineryValues, type CanaryFacts, type CanaryIo, type Suppression,
} from "../org-health.ts";
import { EXIT_NOTHING_SENT, machineryDeclarationProblems, machineryFilesIn, machineryRefusal, main } from "../pr-open.ts";
import { deferredWakeCount, incidentSuppressions, machineryCanaryNow } from "../work-gate.ts";
import { pacedUnread } from "../work-gate/pacing.ts";
import { unreadLanes } from "../work-gate/tick.ts";
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

test("#5100 THE TICK CALLS IT: the gate's `main` puts `machineryCanaryNow`'s orders among its own, once, after the hold holders (a SOURCE pin: `main` is not driven whole by any test, and says so)", () => {
  const source = workGateSource();
  const pushes = source.match(/orders\.push\(\.\.\.machineryCanaryNow\(/g) ?? [];
  assert.equal(pushes.length, 1, "one call per tick: a second would sample twice and double every count");
  assert.ok(source.indexOf("holdHolderOrdersNow({") < source.indexOf("orders.push(...machineryCanaryNow("), "after the hold holders, before the dead man's switch");
});

/** The `blind-ticks` value one tick samples for the lanes it could not read (`unread`, as the gate hands it to `machineryCanaryNow`). */
const blindTicksOf = (unread: string[]): number | null => machineryValues({ facts: facts({ unread }), since: T0 - MINUTE, now: T0, memo: {} }).values[MACHINERY_SIGNALS.BLIND_TICKS];

test("#1329 (1) A PACED TICK IS NOT BLIND: the canary is handed the refused lanes only, so a repository the gate skipped by design samples `blind-ticks` as 0 (the call is a SOURCE pin; the skip is still named on the PARTIAL line)", () => {
  const source = workGateSource();
  assert.match(source, /machineryCanaryNow\(\{ unread: unreadLanes\(\{ prs, readyRows, others \}\)/, "the canary's `unread` is built from the refused lanes, not from `pacedSkips`");
  // a paced tick: both primary lanes read, and the pool's reserve paced the repositories out
  const pacedSkips = [{ refused: pacedUnread({ paced: true, remaining: 10 }, true) }];
  assert.equal(blindTicksOf(unreadLanes({ prs: [], readyRows: [], others: [] })), 0, "nothing refused: 0 blind");
  assert.ok(unreadLanes({ prs: [], readyRows: [], others: pacedSkips }).length > 0, "the PARTIAL line still names the paced lanes, so they are never reported clean");
});

test("#1329 (2) A REFUSED LANE IS BLIND: a refused pull-request list, Ready rows or other repository samples `blind-ticks` as 1", () => {
  assert.equal(blindTicksOf(unreadLanes({ prs: null, readyRows: [], others: [] })), 1, "the pull-request list was refused");
  assert.equal(blindTicksOf(unreadLanes({ prs: [], readyRows: null, others: [] })), 1, "the Ready rows were refused");
  assert.equal(blindTicksOf(unreadLanes({ prs: [], readyRows: [], others: [{ refused: ["the other repositories' lanes"] }] })), 1, "another repository's read was refused");
});
