Closes a11ign/agent-org#1716

Acceptance: grep -q "board-disagrees-with-reality is a number when the audit was read" src/org-health.test.ts && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/org-health.test.ts

Mutation: `machineryValues` records `null` for `board-disagrees-with-reality` whatever the tick made (the count never reaches the canary): the new test fails at its first assertion. `boardTruthOfferCount` reads an unknown reading as zero offers (an unread board is zero): the new test fails at the `null` assertion. Each restored from a copy and confirmed byte-identical with cmp.
