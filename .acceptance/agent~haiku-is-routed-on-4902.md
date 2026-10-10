Haiku is routed on SIZE and CONTAINMENT, not on `mechanical` (a11ign#4902). The decision log (90 minutes to 2026-10-10 21:19Z, 30 records read) had P(mechanical=yes) with a median of 0.10 and none at 0.65, so `composeRoute` sent nothing to Haiku.

**What changes.**
- `takesHaiku` is Haiku/high when P(score <= 2) >= 0.6, OR when P(score <= 3) >= 0.9 AND P(subsystems=yes) <= 0.1 AND P(debugging=yes) <= 0.25. A subsystems or debugging reading not given is not containment.
- `mechanical` stays asked and logged and is no gate; it decides only an UNSCORED row in a small Region, as before. The debugging hold (>= 0.5), the Sonnet/medium rule and the Sonnet/high default are unchanged, and so are the refusals and the no-provider fallback.

**Evidence.** `src/engineer-route.test.ts`: 51 of 51 pass under `node --import tsx --test` (the row's own `npx rstest run <file>` without `--config scripts/rstest/rstest.config.ts` finds no suites); with `route-outcome.test.ts` and `wake.test.ts`, 66 of 66 (measured with `AGENT_ORG_HOST` set to the a11ign worktree's `host.json`). The three named cases: P(mechanical)=0.45, subsystems 0.05, debugging 0.19, P(score<=3) 0.94 is Haiku/high; P(score<=3) 0.93 with subsystems 0.3 is Sonnet/medium; P(score<=3) 0.25 is Sonnet/high. Every threshold has a test at its boundary on both sides.

Hand mutations, each restore diffed byte-identical: `takesHaiku` never firing (19 red); always firing (10 red); the subsystems bound loosened 0.1 to 0.4 (5 red).

Not done here, as the row says: the daily first-pass guard and the share-of-starts report are the existing guard's and a SEPARATE verify row 24h after merge.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx --test src/engineer-route.test.ts`

Closes a11ign/a11ign#4902

Mutation: none -- three hand mutations of `takesHaiku` are recorded under Evidence above; there is no mutation command to run.

platform: n/a (a probability threshold in the router; no platform feature does it)
