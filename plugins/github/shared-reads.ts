// module: one answer for the callers that ask the same thing at about the same time (A11-356)
//
// THE BOARD ASKED GITHUB FOR THE SAME PULL REQUEST ONCE PER CALLER: the sweeps, the early reviewer start and the waits each read a pull request's reviews on their own (`reviews.ts:18` was 35 calls a minute).
// A read made through here is made once and shared: a caller that asks the same key while it is in flight, or within `ttlMs` of its answer, gets that answer. An answer is the host's, not a verdict: a read that failed
// (it rejected, or answered `null`, which every reader here answers for "could not ask") is not kept, so the next ask makes it again, and a time bound this short keeps the board reading what GitHub says now and not what it said a sweep ago.

/** Makes `load` once per `key` within the bound: the answer of the first ask is the answer of every ask until `ttlMs` after it settled. */
export type SharedReads = (<T>(key: string, load: () => Promise<T>) => Promise<T>) & {
  /** Drops what is kept under every key that begins with `prefix`, so the next ask reads afresh; a read in flight stays shared with those already waiting on it. */
  forget(prefix: string): void;
};

/** The shared reads of one code host: answers are kept for `ttlMs`, counted by `now`. */
export function sharedReads({ ttlMs, now = Date.now }: Readonly<{ ttlMs: number; now?: () => number }>): SharedReads {
  const kept = new Map<string, { answer: Promise<unknown>; settledAt: number | null }>();
  const shared = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const at = now();
    for (const [other, entry] of kept) if (entry.settledAt !== null && at - entry.settledAt >= ttlMs) kept.delete(other);
    const held = kept.get(key);
    if (held !== undefined) return held.answer as Promise<never>;
    const entry: { answer: Promise<unknown>; settledAt: number | null } = { answer: load(), settledAt: null };
    kept.set(key, entry);
    const drop = () => { if (kept.get(key) === entry) kept.delete(key); };
    entry.answer.then((answer) => { if (answer === null) drop(); else entry.settledAt = now(); }, drop);
    return entry.answer as Promise<never>;
  };
  return Object.assign(shared, { forget: (prefix: string) => { for (const key of [...kept.keys()]) if (key.startsWith(prefix)) kept.delete(key); } });
}
