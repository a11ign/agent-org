The verdict parser reads a hyphen-joined refusal as a refusal: `not-convinced`, `Not-Convinced`, `NOT-CONVINCED` and `not-yet-convinced` parse as `not-convinced`, where the old `not\s+` read them as the bare word and so as an approval. The spaced forms, the bare `convinced`, the `un-?convinced` arm and the three-word adverb bound are unchanged, and each is pinned in the same test with a negative control. The test fails on the HEAD regex and passes after.

Acceptance:
```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/review-verdict.test.ts
```

Consumer-declaration: none -- the change is internal to agent-org's verdict parser. Its exported return shape is unchanged; only which spellings of a negated verdict match.
