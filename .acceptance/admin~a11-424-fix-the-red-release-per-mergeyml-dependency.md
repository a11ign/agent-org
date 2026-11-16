The `gh` wrapper's pacing clock (`pace_ms` in `plugins/github/wrapper/gh`) is epoch milliseconds on GNU `date`, on uutils `date` (whose `%3N` is bare nanoseconds without leading zeros) and on a `date` with no `%N`. Test (b) in `src/gh-secondary-burst.test.ts` still asserts at most 4 admissions in any 1000 ms window, is not skipped, and now also asserts every recorded admission is an epoch time in milliseconds, so a record in another unit can neither pass it for nothing nor fail it at random.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/gh-secondary-burst.test.ts
```

Consumer-declaration: none -- no existing host file changes meaning. The wrapper reads the same clock under a format every `date` it meets prints the same way.
