Closes a11ign/a11ign#4877

The router sends a mechanical row to Haiku/high up to complexity score 3 (a11ign/a11ign#4877, the chairman's direction on the trial report, a11ign/a11ign#4627 item 3). `HAIKU_MAX_SCORE` goes from 2 to 3, so the rule built on #4875 reads `P(mechanical = yes) >= 0.65 AND P(score <= 3) >= 0.6`. Nothing else moves: the `mechanical` gate, the debugging hold, the Sonnet/medium rule and the order of the two lines in `composeRoute` are as they were, and `MEDIUM_SCORE` is still 3, so a mechanical row at score 3 now takes the Haiku line first. The route line printed `P(score<=3)` twice once both limits were 3, so it now names each distinct level once.

**The boundary is pinned (`src/engineer-route.test.ts`):** a mechanical row with its score mass at level 3 routes `haiku/high` (it routed `sonnet/medium`); mass at level 4 stays `sonnet/high`; P(score <= 3) of exactly 0.6 qualifies and 0.59 does not; and the CONTROL, a row whose `mechanical` is not confidently yes, stays `sonnet/medium` at score 1 and at score 3, so the loosening is about the score and not about the mechanical gate. Four older tests pinned the old limit (a level-3 row as Sonnet/medium; a 0.45/0.4 split as Sonnet/medium; the decision-log line printing `P(score<=2)`); they now say Haiku/high and the one printed reading.

Acceptance: `cd /home/agent/repos/agent-org && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/engineer-route.test.ts`

Mutation: `HAIKU_MAX_SCORE` put back to 2 (measured): 6 of 51 tests red, each a level-3 / adjacent-split / printed-reading boundary, and no other file's test moved (`src/decision-provider.test.ts` 20 of 20 either way). Restored with `cp` and proved byte-identical with `diff`. Result with the change: 51 of 51 pass.
platform: n/a (no part of GitHub, systemd or git decides which model a row is routed to; this is this tool's own threshold)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
