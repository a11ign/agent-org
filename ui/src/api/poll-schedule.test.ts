import { MAX_BACKOFF_MS, MIN_BACKOFF_MS, nextDelay, POLL_MS } from "./poll-schedule.ts";

describe("nextDelay", () => {
  it("waits 5s after a success", () => {
    expect(nextDelay(0)).toBe(5_000);
    expect(POLL_MS).toBe(5_000);
  });

  it("backs off from 2s, doubling with each failure in a row", () => {
    expect([1, 2, 3, 4, 5].map(nextDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(MIN_BACKOFF_MS).toBe(2_000);
  });

  it("stops doubling at 60s and stays there however long the failures run", () => {
    expect([6, 7, 20, 1_000].map(nextDelay)).toEqual([60_000, 60_000, 60_000, 60_000]);
    expect(MAX_BACKOFF_MS).toBe(60_000);
  });
});
