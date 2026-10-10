The work tick runs the messaging audit: `recordTickFailures` calls `auditMessaging` once per tick, after the other recorders, so an announcement that asks the chairman something files a `messaging-audience-misuse` line in `failure-ledger` (a11ign/agent-org#620, follow-up to a11ign/a11ign#4746, #928).

Acceptance:
```bash
bash -c 'cd /home/agent/repos/wt-agent-org-620 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/messaging/audit-tick.test.ts'
```

Printed `VERDICT pass: 5 tests in 1 file`. The cases go through `recordTickFailures` itself over a scratch `home` and `stateDir`: a delivered announcement ending `?` appended after the first tick is ONE `messaging-audience-misuse` line after two ticks and none from the third; its twin (the same text stated) is none and the count line reads `1 checked, 0 flagged`; a host with no ledger writes only the cursor and does not throw; the count line is said every tick; the count line goes to stderr and nothing to stdout.

Mutation:
- The `auditMessaging(...)` call removed from `src/failure-recorders.ts` (the row's control): 5 of 5 red.
- `print: say` dropped, so the count line goes to the audit's default stdout: 3 of 5 red (the count-line cases and the stdout case).
- Each restored from a copy and `diff` showed it byte-identical.

Judgement calls:
- **The count line goes to stderr, not stdout.** The row says "the tick's output beside the other recorders' lines"; the other recorders report on stderr, and the tick's stdout is its orders, one JSON line each, so a count line there would be read as a malformed order. `recordTickFailures` takes an optional `say` (default stderr) so the test reads the line.
- **`home` defaults to `homedir()`**, which is what `work-gate.ts` gets without being touched (its call is outside the Region). `failure-ledger.test.ts` therefore audits the real home's ledger on its first tick; that baselines and writes only a cursor into its scratch `stateDir`.
- A throw from the audit is caught and said, so the recorder still never stops a tick (the audit itself already reports and does not throw).

Neighbours: `src/messaging/audit.test.ts`, `src/failure-ledger.test.ts` and `src/packaging/org-retro.test.ts`: 76 tests, 1 failing: `failure-ledger.test.ts :: the six event kinds are seeded...` (`owner-unresolved: a name, guard null and a guardNote`), which reads the host checkout's `.agent-org/failure-classes.json` and never calls `recordTickFailures`; it is not touched by this diff. `tsc --noEmit` shows only the two `mjs-ratchet.test.ts` errors.

Done-when 1 needs the merge; the Open-check (a live tick over a real ledger) is the gate's reading after it.

Closes a11ign/agent-org#620
