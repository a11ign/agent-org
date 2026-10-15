In `webhook` mode the gate's event gate (`eventGateOf`, `rememberOtherScopesRead` in `src/work-gate/reads.ts`) no longer waits on the default-off `gate.graphqlPacing` flag: a repository no event named and read within the 15-minute sweep is not re-read on a tick, and is reported unread. The host's webhook declaration is the switch; the revert is `"source": "poll"`.

Not here, and named: the 24 h calls-per-hour reading (Done-when 2, baseline 3,538/h on a11ign#928) needs a day of running after merge.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/gate-graphql-pacing.test.ts`
