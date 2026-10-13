`reviewerEnvironment` gives every reviewer instance a writable App-token cache in its own tree (`A11Y_APP_TOKEN_DIR`, agent-org#1342), and gives a keyed repository's reviewer `AGENT_ORG_HOST`, as `spawnEnvironment` gives a worker.

Acceptance:
```bash
AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/wake-reviewer-instance.test.ts src/packaging/keyed-repo-review.test.ts src/packaging/reviewer-app-role.test.ts src/review-trust.test.ts
```

Result on the agents host at the branch head: 4 files, all pass. `tsc --noEmit` exits 0.

Mutations, each restored afterwards:
- Drop `A11Y_APP_TOKEN_DIR` from `reviewerEnvironment`: 3 files red (`wake-reviewer-instance`, `keyed-repo-review`, `review-trust`).
- Drop the keyed reviewer's `AGENT_ORG_HOST`: `keyed-repo-review` red.

Consumer-declaration: none. This adds two environment keys, and no signature changes.
