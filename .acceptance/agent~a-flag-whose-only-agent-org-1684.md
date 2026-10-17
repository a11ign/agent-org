Closes a11ign/agent-org#1684

Acceptance: grep -q "a signal first recorded inside the hour before the flag" src/org-health.test.ts && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/org-health.test.ts

Mutation: `isNew` forced false (the new-signal branch never fires): the new test fails. `isNew` forced true for any sample (the branch always fires): the new test fails, on its negative control (3). Each restored and confirmed byte-identical with cmp.
