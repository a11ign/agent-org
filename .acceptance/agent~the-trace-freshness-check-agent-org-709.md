Class: tail-read-taken-as-the-whole — a bounded read from the END of a file whose answer is reported for the whole file, true only when the file is ordered by the thing asked; the store is not (a cold start appends transcripts in directory order). The other positional tail reads were read, not changed: `lastSaidIn` (`wake.ts`) and `readTail` (`host-units.ts`) read an append-ordered transcript, where the last message in the tail IS the file's last, and `newestMessageAt` widens until it finds one; guard: `newestTurnAt` returns a reading older than the window only after the whole file is read, and the cold-start, window-edge and positive-control cases in `src/trace/freshness.test.ts` go red if it does not.

The trace-freshness check no longer reads a healthy store as stale right after a cold start (a11ign/agent-org#709, part of a11ign/a11ign#4437 move 1b, unit agent-org#498). **The incident:** the 18:30:41Z run of `a11ign-trace-ingest.service` on 2026-10-10 re-read every transcript from byte 0 (`COLD START: state file is not version 5`), appended them in directory order, and `newestTurnAt` took the newest turn of the last 1 MB of the 613 MB store, 2026-10-08T14:02:43Z, as the store's newest: "52h 28m ago ... STALE", a `metrics-outage` incident for a store whose newest turn was five minutes old, on a line far from the end.

**What changes.**
- *`newestTurnAt(storePath, now)`* does not give a reading older than `STALE_AFTER_MS` as the answer. It reads the file backwards in chunks (1 MiB, doubling to 32 MiB; each byte once, a line spanning two chunks joined) until a turn inside the window turns up or the file is exhausted, and returns the newest it saw. `TAIL_LAST_BYTES` is now the largest chunk, no longer a stop. `now` defaults to `Date.now()`; `storeFreshness` passes its own.
- A healthy store stops in the first chunk as before; a genuinely stale one reads all of itself (every five minutes while a session works), which is the price of never reporting a partial file's old turn as the store's newest.
- `STALE_AFTER_MS`, the episode rules and the order text are the same.

**Tests.** New in `src/trace/freshness.test.ts`: the cold-start shape (a turn one minute old on the first line, 30,000 two-day-old turns last, over a window) reads NOT stale and returns the one-minute-old turn; the #710 shape (recent turn early, 70,000 `gh_call` lines, an old turn last) is read to the recent turn; the first window's edge falls inside the recent turn's line; a store of only two-day-old turns reads stale while a session works and returns the newest of them from the first line; a store over a window with no turn, and an empty one, return `null`. The existing cases pass unchanged.

Mutation: the early return restored (`if (newest !== null) return newest;`) -> 4 red (the three cold-start cases and the positive control); restored byte-identical (copy in the scratchpad).

## Acceptance

```bash
node --import tsx --test src/trace/freshness.test.ts
```

The row's `cd /home/agent/repos/agent-org` is dropped: that is the primary checkout, which does not hold this change.

Closes: a11ign/agent-org#709

platform: n/a (no GitHub, pnpm, systemd or git feature; the unit's own `gh` effects are untouched)
