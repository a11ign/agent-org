`arm-approved`'s stack merge (`PUT /pulls/{n}/merge-async`) no longer sends `merge_method=merge`. `main` merges through a merge queue, and GitHub refuses a queued stack merge that names a merge method: "Custom merge params are not supported when merging via a merge queue" (the refusal comment on #2048). So every approved, green stacked pull request (#2048, and #2052 and #2057 above it) stayed out of the queue.

Acceptance:
```bash
pnpm install --frozen-lockfile && AGENT_ORG_HOST=$HOME/.agent-org/host.json pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/packaging/auto-arm-stack-merge.test.ts
```

Consumer-declaration: none -- the repository's own workflow and its test; nothing that ships changes.
