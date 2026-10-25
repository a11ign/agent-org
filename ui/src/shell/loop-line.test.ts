import type { LoopReading } from "../../../src/ticket-mode/loop-delay.ts";
import { delayText, loopLine, WARN_MS } from "./loop-line.ts";

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
    expect(loopLine({ board: reading(18) })).toEqual({ text: "Loop p99 18 ms", warn: false, title: "Board p50 1 ms / p99 18 ms / max 18 ms" });
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
