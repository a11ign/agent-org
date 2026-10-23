A failing check's log and rerun, the review claim and the verdict door are now the GitHub plugin's, which is the third of A11-160's steps: `readCheckLog`, `rerunFailedChecks`, `readReviewClaims`, `writeReviewClaim` and the optional `verdictDoor` join the code host contract (version 1.5, `docs/adr/0006-…`). The pool asks the activated code host for a red check's log and its rerun, and the atomic reviewer reads and writes its claim through it, so `PoolContext.gh`, `ReviewerBoard.gh` and `ghWith` are gone; `claimHead` stays core's. `src/reviewer/pr-review-verdict.sh` and its installer moved to `plugins/github/reviewer/`, and the host's install and `host:check` take their paths from the code host. `docs/gh-call-baseline.json` loses `src/reviewer/pr-review-verdict.sh` and nothing rises. The ratchet's baseline is not yet zero: the gate, wake, claims and row mode move in steps 4 to 9.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github plugins/atomic-reviewer src/plugins src/ticket-mode/pool.test.ts src/ticket-mode/pool-checks.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-port/review-claim.test.ts src/packaging/gh-call-ratchet.test.ts src/packaging/gh-call-inventory.test.ts src/packaging/reviewer-door-install.test.ts src/packaging/door-refuses-stale-head.test.ts src/packaging/door-refuses-second-review.test.ts src/packaging/door-finalises-review-claim.test.ts src/packaging/door-retries-a-failed-mint.test.ts src/packaging/review-attribution.test.ts src/packaging/reviewer-environment-verdict.test.ts src/install/doctor.test.ts
! git diff origin/main -- docs/gh-call-baseline.json | grep -E '^\+[^+]'
git diff origin/main -- docs/gh-call-baseline.json | grep -qE '^-    "src/reviewer/pr-review-verdict.sh": \{'
test ! -e src/reviewer/pr-review-verdict.sh && test -f plugins/github/reviewer/pr-review-verdict.sh && test -f plugins/github/reviewer/install-reviewer-bin.sh
scratch=$(mktemp -d)
bash plugins/github/reviewer/install-reviewer-bin.sh "$scratch/reviewer/bin/pr-review-verdict" > /dev/null
cmp plugins/github/reviewer/pr-review-verdict.sh "$scratch/reviewer/bin/pr-review-verdict"
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" }, "codeHost": { "provider": "github" } } } }' > "$scratch/host.json"
AGENT_ORG_HOST="$scratch/host.json" node src/bin.ts plugin list | grep -qE '^  github  *enabled  *contract 1\.5  *plugins/github$'
rm -rf "${scratch:?}"
```

Consumer-declaration: none -- no host file changes meaning: `tickets.providers.codeHost` keeps its shape. The installed door `~/reviewer/bin/pr-review-verdict` is a copy of the same bytes and `host:check` reports it CURRENT; no other repository reads `src/reviewer/pr-review-verdict.sh`.
