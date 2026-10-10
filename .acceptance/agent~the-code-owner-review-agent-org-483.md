Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/work-gate-codeowner-review-repos.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/closed-answer-rows-reason.test.ts
```

Mutation: the owner-review filter made never settle -> 4 of 13 red; made settle for any author -> 1 red; the head comparison removed -> 1 red; the switch ignored -> 1 red; `CHANGES_REQUESTED` not counted -> 2 red; `CHANGES_REQUESTED` with no sha counted -> 1 red; `APPROVED` with no sha not counted -> 1 red. The closed-rows refusal: reason never recorded -> 4 of 5 red; `[]` returned in place of `null` -> 4 red; the previous read's reason left standing -> 1 red; the reason taken from the error's first line alone -> 1 red. Each restored from a copy taken before and `diff`ed byte-identical.
