Org health now reports how often a required check was rerun on a 5xx (`required-red-on-5xx`, per UTC day, with the run ids, read from the `checks rerun on 5xx` ledger by `readRerunsOn5xx`) and how often a person reran a 5xx-red run by hand (`manual-reruns`, which asks `rerunOn5xx` whether the last error is a 5xx and excludes runs in the tick's own ledger). A day with none is `clear` with a printed zero; an unreadable ledger or read is `unknown`, never zero. Both ride `orgHealthReadings` only when the caller passes `rerunsOn5xx` / `rerunsSeen`.

Acceptance: `node --test src/ci-rerun-on-5xx.test.ts src/org-health.test.ts src/org-health-5xx-reruns.test.ts`

Measured: `ℹ tests 23, pass 23, fail 0`; `pnpm run typecheck` clean.

Mutation: `src/org-health.ts` backed up with `cp` and restored byte-identical (`diff`). Dropping the tick-ledger exclusion in `manualRerunsReading` fails the manual-reruns test.

Not done, outside the Region: the live gate (`work-gate.ts`) does not yet hand `rerunsOn5xx` / `rerunsSeen` to the tick, so the signals do not fire live until it does; a follow-up row is filed for it. Not run: `pnpm run verify`.

Closes a11ign/agent-org#1218
