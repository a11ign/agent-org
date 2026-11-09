---
"agent-org": patch
---

The `gh` wrapper's pacing clock reads milliseconds on a uutils `date` (Ubuntu 26.04's, this host's and CI's `ubuntu-latest` since 2026-11-08). `pace_ms` read `date +%s%3N`, but uutils ignores the `3` and prints the nanoseconds without their leading zeros, so on this host a start was a 19-digit nanosecond count, and the per-minute pacing window of 60000 "milliseconds" was 60 microseconds: calls were never paced. The same zero-dropping makes a start in the first 100 ms of a second 10 to 1000 times too small, which puts the starts of ten different seconds in one 1000 ms window; that is the likely reason `src/gh-secondary-burst.test.ts` (b) read 5 or 6 admissions on unrelated pull requests since 2026-11-08 (A11-424). The clock is now `date +%s%N` cut to milliseconds, which is nine zero-padded digits on both GNU and uutils `date`; a `date` that prints anything else falls back to whole seconds, as before.
