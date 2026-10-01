// @ts-check
// THE RATE LIMIT (decision 1): a token bucket from the provider's declared capability (Telegram: about one message a second per
// chat), plus an HOURLY CAP whose overflow the core collapses into ONE digest line rather than dropping. A LEAF module with an
// injected clock, so a test spends no real time.
//
// The two refusals mean different things, which is why `tryAcquire` names which one fired: `rate` is a wait of seconds (the event
// stays unsent and the next tick retries it), `hourly-cap` is a wait of up to an hour (so the event is held for the digest).
//
// **The hourly count is of DELIVERED messages**, not attempts: a provider that is down must not use up the hour's allowance on
// attempts that reached nobody. The token bucket, by contrast, is spent on every attempt, because it exists to stop a failing
// provider being hammered.

const MS_PER_SECOND = 1000;
const HOUR_MS = 3_600_000;

export const DEFAULT_RATE = Object.freeze({ ratePerSecond: 1, burst: 3, hourlyCap: 12, windowMs: HOUR_MS });

/**
 * @param {{now: () => number, ratePerSecond?: number, burst?: number, hourlyCap?: number, windowMs?: number}} options
 * @returns {{tryAcquire: () => {ok: true} | {ok: false, reason: "rate" | "hourly-cap"},
 *            noteDelivered: (at?: number) => void, hasHourlyRoom: () => boolean}}
 */
export function createRateLimiter({ now, ...overrides }) {
  // An option the caller passes as `undefined` (a provider that declares no `ratePerSecond`) means "use the default", and a plain
  // spread would instead overwrite the default with `undefined`, turn the bucket's arithmetic into NaN and let everything through.
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  const { ratePerSecond, burst, hourlyCap, windowMs } = { ...DEFAULT_RATE, ...defined };
  let tokens = burst;
  let refilledAt = now();
  /** @type {number[]} */
  let delivered = [];

  const refill = () => {
    const at = now();
    tokens = Math.min(burst, tokens + ((at - refilledAt) / MS_PER_SECOND) * ratePerSecond);
    refilledAt = at;
  };
  const prune = () => {
    const horizon = now() - windowMs;
    delivered = delivered.filter((at) => at > horizon);
  };
  const hasHourlyRoom = () => {
    prune();
    return delivered.length < hourlyCap;
  };

  return {
    hasHourlyRoom,
    tryAcquire() {
      if (!hasHourlyRoom()) return { ok: false, reason: "hourly-cap" };
      refill();
      if (tokens < 1) return { ok: false, reason: "rate" };
      tokens -= 1;
      return { ok: true };
    },
    noteDelivered(at = now()) {
      delivered.push(at);
    },
  };
}
