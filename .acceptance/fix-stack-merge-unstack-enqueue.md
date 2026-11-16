`arm-approved` answers GitHub's refusal of the stack merge to an App ("Enqueuer is not authorized to merge", #2048) by taking the pull request, the bottom open member, out of its stack, arming it alone with auto-merge, and stacking the open members above it again. Any other refusal is shown as before.

Acceptance:
```bash
pnpm install --frozen-lockfile && AGENT_ORG_HOST=$HOME/.agent-org/host.json pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/packaging/auto-arm-stack-merge.test.ts
```

Consumer-declaration: none -- the repository's own workflow and its test; nothing that ships changes.
