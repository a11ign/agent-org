A pull request from outside the org (a fork, or an author not declared by the org) is reviewed read-only, and nothing from it runs on the host (a11ign/agent-org#1311).

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/review-trust.test.ts`

The row's own command cds to `~/repos/agent-org`, where `src/review-trust.test.ts` does not exist until this PR merges, so it is refused with "No test files found". This command runs in the checkout the PR is built from.

Mutation: forcing `reviewTrustOf` to INSIDE for every pull request turns 5 tests red, all in `src/review-trust.test.ts`. The file is restored byte-identical afterwards. The fork-only mutation was not measured on this head, so no count is claimed for it.

Outside-Region: .acceptance/agent~a-pull-request-from-agent-org-1311.md — the PR's own Acceptance file (ADR 0044); src/work-gate/tick.ts (passes declared identities through decide and scopeTick); the test fixtures under src/packaging/ and src/*.test.ts (declared identities and trust on hand-built orders); .changeset/outside-pr-read-only-1311.md.
