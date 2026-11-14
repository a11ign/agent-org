`plugins/github-issues` is a second tracker plugin: the open issues of one GitHub repository are the board's tickets, read and written through GitHub's REST API with a token (A11-447, step 1 of 2). It passes the tracker contract suite against an in-memory GitHub (`fake-github.ts`), and its README says how Linear's states, labels, label groups, priorities, projects, sub-issues and blocked-by map onto GitHub Issues. No test reaches GitHub.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github-issues/ src/plugins/built-in.test.ts src/plugins/health.test.ts src/plugins/boundary.test.ts
```

Mutation: in `plugins/github-issues/source.ts`, make `claim` post its comment unconditionally, and the conformance test fails on "a repeated claim changes nothing"; make `stateOf` in `mapping.ts` ignore `state_reason`, and the mapping test fails on Canceled and Duplicate.

Consumer-declaration: none -- the tracker contract does not change, and no host file key changes for a host that keeps `linear`. A host may now name `github-issues` as `tickets.providers.tracker.provider`, with the settings the plugin's README lists.
