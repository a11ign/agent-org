import type { LoopReading } from "../../../src/ticket-mode/loop-delay.ts";
import type { HealthFigures } from "../../../src/ticket-mode/health-figures.ts";
import { ageText, delayText, figureDetails, loopLine, WARN_MS } from "./loop-line.ts";

const reading = (p99Ms: number, p50Ms = 1, maxMs = p99Ms): LoopReading => ({ p50Ms, p99Ms, maxMs, windowMs: 60_000, sinceStartMaxMs: maxMs, at: 1_761_400_000_000 });

describe("delayText", () => {
  it("says whole ms below a second, and seconds with one decimal place from a second up", () => {
    expect(delayText(18.4)).toBe("18 ms");
    expect(delayText(0)).toBe("0 ms");
    expect(delayText(999.4)).toBe("999 ms");
    expect(delayText(999.6)).toBe("1.0 s");
    expect(delayText(1000)).toBe("1.0 s");
    expect(delayText(4_213)).toBe("4.2 s");
  });
});

describe("loopLine", () => {
  it("is not drawn before a reading, or for an instance that gives none, even when the page's own service gave one", () => {
    expect(loopLine({})).toBeNull();
    expect(loopLine({ page: reading(2) })).toBeNull();
  });

  it("shows the board loop's p99 from an instance with one loop, muted below the warning", () => {
    expect(loopLine({ board: reading(18) })).toEqual({ text: "Loop p99 18 ms", warn: false, title: "Board p50 1 ms / p99 18 ms / max 18 ms", details: [], flags: [] });
  });

  it("shows the request thread's p99 when the instance has one, and lists every reading in the tooltip", () => {
    const line = loopLine({ requests: reading(4, 1, 9), board: reading(2_013, 0, 6_680), page: reading(1, 0, 3) });
    expect(line?.text).toBe("Loop p99 4 ms");
    expect(line?.warn).toBe(false);
    expect(line?.title).toBe("Requests p50 1 ms / p99 4 ms / max 9 ms, Board p50 0 ms / p99 2.0 s / max 6.7 s, Page p50 0 ms / p99 1 ms / max 3 ms");
  });

  it(`warns from ${WARN_MS} ms, and says what is holding the board`, () => {
    expect(loopLine({ board: reading(WARN_MS - 1) })?.warn).toBe(false);
    expect(loopLine({ board: reading(WARN_MS) })).toMatchObject({ text: "Loop p99 100 ms: background work is holding the board", warn: true });
    expect(loopLine({ board: reading(1_213) })?.text).toBe("Loop p99 1.2 s: background work is holding the board");
  });
});

const FIGURES: HealthFigures = {
  at: 1_761_400_000_000, uptimeMs: 7_200_000,
  loop: { lastMinute: { p50Ms: 1, p99Ms: 18 }, lastHour: { p50Ms: 2, p99Ms: 40 } },
  syncHolds: { lastHour: 3, holdMs: 100 },
  calls: { linear: { calls: 400, failures: 2, failuresPer100: 0.5 }, github: { calls: 1_000, failures: 0, failuresPer100: 0 } },
  runs: { sinceLastStartMs: 180_000, startable: 2, freeSlots: 1, starting: 0, oldestStartingMs: null, holding: null },
  fill: { sinceLastCompletedMs: 4_000, lastEarlyReturn: null },
};

describe("ageText", () => {
  it("says seconds below a minute, whole minutes below an hour, and hours from an hour up", () => {
    expect([ageText(4_000), ageText(59_400), ageText(180_000), ageText(3_540_000), ageText(5_400_000)]).toEqual(["4 s", "59 s", "3 min", "59 min", "1.5 h"]);
  });
});

describe("the figures under the loop line (A11-363)", () => {
  it("shows the loop over a minute and an hour with the holds, the failed calls per 100, the last start, the startable runs and free slots, and the last fill", () => {
    expect(figureDetails(FIGURES)).toEqual([
      "Loop p50/p99: 1 ms / 18 ms over 1 min, 2 ms / 40 ms over 1 h; 3 holds an hour",
      "Failed calls per 100: Linear 0.5, GitHub 0",
      "Last run start 3 min ago; 2 startable runs, 1 free slot; last fill 4 s ago",
    ]);
  });

  it("says why the last fill pass returned early, and that nothing has started or filled yet", () => {
    const stuck: HealthFigures = { ...FIGURES, runs: { ...FIGURES.runs, sinceLastStartMs: null, startable: 1 }, fill: { sinceLastCompletedMs: null, lastEarlyReturn: { reason: "a read of the tracker or the code host failed: fetch failed", agoMs: 3_000 } } };
    expect(figureDetails(stuck)[2]).toBe("Last run start never; 1 startable run, 1 free slot; last fill not yet; its last pass returned early: a read of the tracker or the code host failed: fetch failed");
  });

  it("flags a loop p99 over 100 ms in either window, call failures over 1%, and a watchdog restart in the last day, and nothing else", () => {
    expect(loopLine({ board: reading(18), figures: FIGURES })?.flags).toEqual([]);
    const sick: HealthFigures = { ...FIGURES, loop: { lastMinute: { p50Ms: 1, p99Ms: 18 }, lastHour: { p50Ms: 2, p99Ms: 240 } }, calls: { ...FIGURES.calls, linear: { calls: 100, failures: 3, failuresPer100: 3 } } };
    const line = loopLine({ board: reading(18), figures: sick, watchdog: { restartsLastHour: 1, restartsLastDay: 1, restartsTotal: 4, last: { at: 1, reason: "no-fill", detail: "no fill() pass has completed for 5.1 min" } } });
    expect(line?.flags).toEqual([
      "Event loop lag p99 is 240 ms over the last hour, over 100 ms: background work is holding the board",
      "Linear calls fail 3 in 100 (3 of 100 in the last hour), over 1",
      "The watchdog restarted the board 1 time in the last day; the last was for no-fill: no fill() pass has completed for 5.1 min",
    ]);
  });

  it("draws no figure lines for an instance that serves none", () => {
    expect(loopLine({ board: reading(18) })).toMatchObject({ details: [], flags: [] });
  });
});
