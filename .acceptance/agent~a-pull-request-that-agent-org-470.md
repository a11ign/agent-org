`blockerVerdict` ignores an open blocker that the same pull request closes, so a pull request closing both rows 5 and 6, with row 5 blocked by #6 is `clear` instead of deadlocking (a11ign/lab#39). The match is on the closing row's repository and number.

Closes a11ign/agent-org#470

Acceptance:
```bash
AGENT_ORG_HOST=/home/agent/repos/wt-4804/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/arm-refuses-open-blocker.test.ts
```

Mutation: the filter made never fire -> 4 of 26 red (the lab#39 case, the full-name pair, the closing blocker's own blockers, and the `cannot-ask` pair); made always fire (every blocker dropped) -> 18 of 26 red; matched on the number alone -> 1 red (the other-repository control). Each restored from a copy taken before and `diff`ed byte-identical.
