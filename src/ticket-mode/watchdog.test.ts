// no-token: gh -- the clock, the probe, the unit's age and the restart are injected; the record is a file in a throwaway folder; nothing is spawned or sent
// A11-363: the watchdog restarts the instance for each of its three triggers, keeps the runs that are starting, counts and logs each restart, and leaves a stopped instance alone
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { HealthFigures } from "./health-figures.ts";
import { ACTIVE_GRACE_MS, decide, NO_ANSWER_MS, NO_FILL_MS, NO_START_MS, probeHealth, runWatchdog, STARTING_GRACE_MS, type HealthAnswer, type Observation, type Probe, type WatchdogDeps } from "./watchdog.ts";
import { readRecord, watchdogPath } from "./watchdog-record.ts";

const MINUTE = 60_000;
const NOON = Date.parse("2026-10-27T12:00:00Z");

/** Figures of an instance that has run an hour, with a pass 4 s ago, a run started 2 min ago, and nothing waiting to start unless a test says so. */
function figures(over: { uptimeMs?: number; sinceFill?: number | null; sinceStart?: number | null; startable?: number; freeSlots?: number; starting?: number; oldestStarting?: number | null; early?: string } = {}): HealthFigures {
  return {
    at: NOON, uptimeMs: over.uptimeMs ?? 60 * MINUTE,
    loop: { lastMinute: { p50Ms: 1, p99Ms: 5 }, lastHour: { p50Ms: 1, p99Ms: 9 } }, syncHolds: { lastHour: 0, holdMs: 100 },
    calls: { linear: { calls: 0, failures: 0, failuresPer100: 0 }, github: { calls: 0, failures: 0, failuresPer100: 0 } },
    runs: { sinceLastStartMs: over.sinceStart === undefined ? 2 * MINUTE : over.sinceStart, startable: over.startable ?? 0, freeSlots: over.freeSlots ?? 2, starting: over.starting ?? 0, oldestStartingMs: over.oldestStarting ?? null, holding: null },
    fill: { sinceLastCompletedMs: over.sinceFill === undefined ? 4_000 : over.sinceFill, lastEarlyReturn: over.early === undefined ? null : { reason: over.early, agoMs: 1_000 }, held: [] },
  };
}

const answered = (figs: HealthFigures | null, boardSnapshotAgeMs = 1_000): Probe => ({ kind: "answered", health: { boardSnapshotAgeMs, figures: figs } });
const seen = (probe: Probe, over: Partial<Observation> = {}): Observation => ({ probe, probedAt: NOON, now: NOON, unansweredSince: null, activeForMs: 60 * MINUTE, ...over });
const reasonOf = (verdict: ReturnType<typeof decide>): string | null => (verdict.act === "restart" ? verdict.reason : null);
const detailOf = (verdict: ReturnType<typeof decide>): string => (verdict.act === "restart" ? verdict.detail : "");

test("a healthy instance is left alone", () => {
  assert.deepEqual(decide(seen(answered(figures()))), { act: "none", unansweredSince: null, note: "healthy" });
});

test("trigger 1: queued runs could start, slots are free and nothing has started for 10 minutes restarts the instance; one minute short does not", () => {
  const stuck = (sinceStart: number) => decide(seen(answered(figures({ startable: 2, freeSlots: 1, sinceStart }), 0)));
  assert.deepEqual(stuck(NO_START_MS - MINUTE), { act: "none", unansweredSince: null, note: "healthy" });
  const verdict = stuck(NO_START_MS + MINUTE);
  assert.equal(reasonOf(verdict), "no-start");
  assert.match(detailOf(verdict), /2 queued runs could start, 1 slot is free, and nothing has started for 11\.0 min/);
});

test("trigger 1 needs both a startable run and a free slot: a full board, or an empty queue, is not a stall however long since the last start", () => {
  assert.equal(decide(seen(answered(figures({ startable: 2, freeSlots: 0, sinceStart: 90 * MINUTE })))).act, "none", "no free slot");
  assert.equal(decide(seen(answered(figures({ startable: 0, freeSlots: 2, sinceStart: 90 * MINUTE })))).act, "none", "nothing queued that can start");
});

test("trigger 1 counts from the start of an instance younger than the limit: a fresh instance with an old queue has not failed to start anything yet", () => {
  assert.equal(decide(seen(answered(figures({ startable: 2, freeSlots: 1, sinceStart: 3 * 60 * MINUTE, uptimeMs: 4 * MINUTE }), 0))).act, "none");
  assert.equal(decide(seen(answered(figures({ startable: 2, freeSlots: 1, sinceStart: null, uptimeMs: 11 * MINUTE }), 0))).act, "restart", "no run ever started, and the instance has been up 11 minutes");
});

test("trigger 2: no fill() pass has completed for 5 minutes restarts the instance, and says why the last pass returned early", () => {
  assert.equal(decide(seen(answered(figures({ sinceFill: NO_FILL_MS - MINUTE }), 0))).act, "none");
  const verdict = decide(seen(answered(figures({ sinceFill: NO_FILL_MS + MINUTE, early: "a read of the tracker or the code host failed: fetch failed" }), 0)));
  assert.equal(reasonOf(verdict), "no-fill");
  assert.match(detailOf(verdict), /no fill\(\) pass has completed for 6\.0 min; the last returned early: a read of the tracker or the code host failed: fetch failed/);
});

test("trigger 2 counts a fresh instance's missing pass from its start", () => {
  assert.equal(decide(seen(answered(figures({ sinceFill: null, uptimeMs: 2 * MINUTE }), 0))).act, "none");
  assert.equal(decide(seen(answered(figures({ sinceFill: null, uptimeMs: 6 * MINUTE }), 0))).act, "restart");
});

test("the figures are as old as the board's last snapshot: a board thread that stopped posting reads as time since that keeps growing", () => {
  const frozen = figures({ sinceFill: 10_000 });
  assert.equal(decide(seen(answered(frozen, 60_000))).act, "none", "a minute-old snapshot of a 10 s pass");
  assert.equal(reasonOf(decide(seen(answered(frozen, NO_FILL_MS)))), "no-fill", "five minutes on, the pass the snapshot showed is five minutes older");
});

test("trigger 3: /api/health that has not answered for 30 s restarts the instance; a first failure is only noted, and a refusal that clears is forgotten", () => {
  const hung: Probe = { kind: "unanswered", why: "no answer within 30 s" };
  const verdict = decide(seen(hung, { probedAt: NOON - NO_ANSWER_MS, now: NOON }));
  assert.equal(reasonOf(verdict), "no-answer");
  assert.match(detailOf(verdict), /has not answered for 30 s \(no answer within 30 s\)/);
  const refused: Probe = { kind: "unanswered", why: "ECONNREFUSED" };
  assert.deepEqual(decide(seen(refused)), { act: "none", unansweredSince: NOON, note: "/api/health did not answer (ECONNREFUSED); asked again next time" });
  assert.equal(decide(seen(refused, { unansweredSince: NOON - MINUTE })).act, "restart", "still refused a minute later");
  assert.deepEqual(decide(seen(answered(figures()), { unansweredSince: NOON - MINUTE })), { act: "none", unansweredSince: null, note: "healthy" });
});

test("an instance that became active less than 2 minutes ago is still starting, and is not restarted for not answering", () => {
  const refused: Probe = { kind: "unanswered", why: "ECONNREFUSED" };
  assert.equal(decide(seen(refused, { activeForMs: ACTIVE_GRACE_MS - 1_000, unansweredSince: NOON - 5 * MINUTE })).act, "none");
  assert.equal(decide(seen(refused, { activeForMs: ACTIVE_GRACE_MS + 1_000, unansweredSince: NOON - 5 * MINUTE })).act, "restart");
});

test("an instance that is not running is not restarted: a person stopped it", () => {
  const verdict = decide(seen({ kind: "unanswered", why: "ECONNREFUSED" }, { activeForMs: null, unansweredSince: NOON - 5 * MINUTE }));
  assert.deepEqual(verdict, { act: "none", unansweredSince: null, note: "the instance is not running, so there is nothing to restart" });
});

test("a restart waits while a run is still starting (its agent is not open yet), for no more than 2 minutes, so a restart keeps its runs", () => {
  const stuck = (oldestStarting: number) => decide(seen(answered(figures({ sinceFill: 10 * MINUTE, starting: 1, oldestStarting }), 0)));
  const held = stuck(STARTING_GRACE_MS - 10_000);
  assert.equal(held.act, "none");
  assert.match(held.act === "none" ? held.note : "", /would restart \(no-fill\), but 1 run is still starting/);
  assert.equal(stuck(STARTING_GRACE_MS + 10_000).act, "restart", "a start that has taken longer than that is stuck, not starting");
});

test("the probe reads the figures and the snapshot's age from /api/health, and says why when it gets none", async () => {
  const figs = figures();
  const ok = await probeHealth(4747, 1_000, (async () => new Response(JSON.stringify({ boardSnapshotAgeMs: 2_500, figures: figs }), { status: 200 })) as typeof fetch);
  assert.deepEqual(ok, { kind: "answered", health: { boardSnapshotAgeMs: 2_500, figures: figs } satisfies HealthAnswer });
  const older = await probeHealth(4747, 1_000, (async () => new Response(JSON.stringify({ loop: {} }), { status: 200 })) as typeof fetch);
  assert.deepEqual(older, { kind: "answered", health: { boardSnapshotAgeMs: 0, figures: null } }, "an instance from before the figures answers, with none");
  assert.deepEqual(await probeHealth(4747, 1_000, (async () => new Response("", { status: 503 })) as typeof fetch), { kind: "unanswered", why: "it answered 503" });
  for (const bad of [{}, { ...figs, runs: { ...figs.runs, startable: "2" } }, { ...figs, fill: null }, { ...figs, uptimeMs: Number.NaN }]) {
    const answer = await probeHealth(4747, 1_000, (async () => new Response(JSON.stringify({ boardSnapshotAgeMs: 0, figures: bad }), { status: 200 })) as typeof fetch);
    assert.deepEqual(answer, { kind: "unanswered", why: "it answered with figures the watchdog cannot read" }, `figures that are not figures are no answer: ${JSON.stringify(bad)}`);
  }
  for (const age of [undefined, "2500", null, -Infinity]) {
    const answer = await probeHealth(4747, 1_000, (async () => new Response(JSON.stringify({ boardSnapshotAgeMs: age, figures: figs }), { status: 200 })) as typeof fetch);
    assert.deepEqual(answer, { kind: "unanswered", why: "it answered figures without a readable snapshot age" }, `figures of no readable age are no answer: ${String(age)}`);
  }
  const refused = (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as typeof fetch;
  assert.deepEqual(await probeHealth(4747, 1_000, refused), { kind: "unanswered", why: "ECONNREFUSED" });
  const slow = ((_url: unknown, init?: RequestInit) => new Promise((_done, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)); })) as typeof fetch;
  assert.deepEqual(await probeHealth(4747, 20, slow), { kind: "unanswered", why: "no answer within 0 s" });
});

/** A watchdog run over a throwaway record: the probe answers `probes` in turn, the clock is `clock.now`, and every restart and log line is kept. */
function watchdogOver(probes: Probe[], options: { activeForMs?: number | null; restartFails?: boolean } = {}) {
  const recordPath = watchdogPath(tmpDir("watchdog-"));
  const clock = { now: NOON };
  const log: string[] = [];
  const restarts: number[] = [];
  const deps: WatchdogDeps = {
    now: () => clock.now, probe: async () => probes.shift() ?? { kind: "unanswered", why: "no probe" }, activeForMs: () => (options.activeForMs === undefined ? 60 * MINUTE : options.activeForMs),
    restart: () => {
      if (options.restartFails) throw new Error("the service manager refused the restart: Unit not found");
      restarts.push(clock.now);
    },
    recordPath, log: (line) => log.push(line),
  };
  return { deps, clock, log, restarts, recordPath, run: () => runWatchdog(deps) };
}

test("a stalled instance is restarted once, the restart is logged with its reason and counted in the record, and a healthy run restarts nothing", async () => {
  const stalled = answered(figures({ startable: 1, freeSlots: 1, sinceStart: 20 * MINUTE }), 0);
  const watched = watchdogOver([answered(figures()), stalled]);
  assert.equal((await watched.run()).act, "none");
  assert.deepEqual([watched.restarts, watched.log], [[], []], "healthy: nothing restarted, nothing said");
  assert.equal((await watched.run()).act, "restart");
  assert.deepEqual(watched.restarts, [NOON]);
  assert.match(watched.log[0]!, /^watchdog: restarting the instance \(no-start\): 1 queued run could start, 1 slot is free, and nothing has started for 20\.0 min\. Restart 1 in all, 1 this hour$/);
  const record = readRecord(watched.recordPath);
  assert.equal(record.count, 1);
  assert.deepEqual(record.restarts.map(({ at, reason }) => [at, reason]), [[NOON, "no-start"]]);
});

test("more than 2 restarts in an hour is said in the log as a defect for the hour; 2 are not", async () => {
  const stall = () => answered(figures({ sinceFill: 9 * MINUTE }), 0);
  const watched = watchdogOver([stall(), stall(), stall()]);
  for (const minute of [0, 10, 20]) {
    watched.clock.now = NOON + minute * MINUTE;
    await watched.run();
  }
  assert.equal(watched.restarts.length, 3);
  assert.equal(watched.log.filter((line) => line.includes("asks for a defect ticket")).length, 1, "said at the third restart, not the second");
  assert.match(watched.log[2]!, /Restart 3 in all, 3 this hour/);
  assert.match(watched.log[3]!, /3 restarts this hour, so the board asks for a defect ticket for the hour/);
});

test("a restart the service manager refuses is said as an error and not counted, and the run fails", async () => {
  const watched = watchdogOver([answered(figures({ sinceFill: 9 * MINUTE }), 0)], { restartFails: true });
  await assert.rejects(watched.run(), /Unit not found/);
  assert.match(watched.log.at(-1)!, /^ERROR watchdog: the restart was refused: the service manager/);
  assert.equal(readRecord(watched.recordPath).count, 0);
});

test("a hung /api/health is restarted on the run that waited 30 s for it, and a refusal is remembered between runs until the next one", async () => {
  const hung = watchdogOver([{ kind: "unanswered", why: "no answer within 30 s" }]);
  let calls = 0;
  const waited = await runWatchdog({ ...hung.deps, now: () => NOON + (calls++ === 0 ? 0 : NO_ANSWER_MS) });
  assert.equal(waited.act, "restart");
  const refused = watchdogOver([{ kind: "unanswered", why: "ECONNREFUSED" }, { kind: "unanswered", why: "ECONNREFUSED" }]);
  assert.equal((await refused.run()).act, "none");
  assert.equal(readRecord(refused.recordPath).unansweredSince, NOON, "the first refusal is on record");
  refused.clock.now = NOON + MINUTE;
  assert.equal((await refused.run()).act, "restart", "refused a minute later too");
  assert.equal(readRecord(refused.recordPath).unansweredSince, null, "a restart ends the run of failures");
});

test("a record that cannot be read is set aside, not written over: it is said as an error, kept beside itself, and the restart still happens on a record of its own", async () => {
  const watched = watchdogOver([answered(figures({ sinceFill: 9 * MINUTE }), 0)]);
  mkdirSync(dirname(watched.recordPath), { recursive: true });
  writeFileSync(watched.recordPath, "{ not json");
  assert.equal((await watched.run()).act, "restart");
  assert.match(watched.log[0]!, /^ERROR watchdog: .*; it is kept as .*watchdog\.json\.unreadable-2026-10-27T12-00-00-000Z, and restarts are counted from none$/);
  const kept = readdirSync(dirname(watched.recordPath)).filter((name) => name.includes(".unreadable-"));
  assert.equal(kept.length, 1, "what the file held is kept");
  assert.equal(readFileSync(join(dirname(watched.recordPath), kept[0]!), "utf8"), "{ not json");
  assert.equal(readRecord(watched.recordPath).count, 1);
});

test("the record's path is in the board's tickets folder", () => {
  assert.equal(watchdogPath("/state"), join("/state", "tickets", "watchdog.json"));
});
