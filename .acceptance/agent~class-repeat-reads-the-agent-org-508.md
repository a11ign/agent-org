`class-repeat.test.ts` gains the end-to-end case agent-org#508 asks for: a ledger holding two refs under each of `unclassified` and `unidentified-caller-order` and no closed rows makes `classRepeatReadings` return `clear`, and a ledger key that is neither a counter nor indexed (`mystery-kind`) is still named as `unknown class`. The filter itself landed in agent-org#540 (a11ign/a11ign#4618); this row adds the test and nothing in `src/class-repeat.ts`.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/role-product-manager/.agent-org/host.json node --import tsx --test src/class-repeat.test.ts`

Class: none — a missing test over a fix that already merged.

Mutation: dropped `&& !LEDGER_COUNTER_KINDS.has(classKey)` from `groupByClass` (2 tests failed: the #4618 unit test and the new one); the file was restored byte-identical (`git diff --quiet` clean).

Measured: 21 tests in `class-repeat.test.ts` pass at agent-org `5f4b499` plus this change; `tsc` reports nothing in `class-repeat`. Journal: the last `unknown class` line is 2026-10-09T20:28:59+01:00 (19:28:59Z, the release of #540); `journalctl --user -u a11ign-work-tick --since -45min -o cat | grep -c 'unknown class'` -> 0 at 2026-10-10T09:21Z, with `org-health:` lines present in the same window.

Closes a11ign/agent-org#508
