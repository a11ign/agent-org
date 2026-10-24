Refs A11-203

Step 3 of 8 (agent-org): `auto-arm.sts.yaml` now asks Octo STS for `workflows: write` as well, so GitHub no longer refuses `enablePullRequestAutoMerge` to the arm bot for an approved pull request that changes a file under `.github/workflows/`. The `WHAT IT HOLDS` comment names the third grant and a new `WHY workflows` paragraph says why (a11ign/lab#150, lab#148, the chairman's decision of 2026-10-24). The pinning test asserts the three grants. The issuer, `subject_pattern` and `claim_pattern` (`job_workflow_ref`, `event_name: pull_request_target|workflow_dispatch`) are unchanged, so only main's own `auto-arm.yml` can get the token.

Acceptance: the diff touches only the policy and its pinning test, the policy's non-comment diff is the one added line, the comment gives the reason, and the pinning test passes.

```bash
set -e
git fetch -q origin main
# only this step's paths (plus .acceptance/)
test -z "$(git diff --name-only origin/main...HEAD | grep -vE '^(\.acceptance/|\.github/chainguard/auto-arm\.sts\.yaml$|src/packaging/auto-arm-octo-sts\.test\.ts$)')"
# the non-comment policy diff is exactly the one added line: the binding and subject pattern did not change
test "$(diff <(git show origin/main:.github/chainguard/auto-arm.sts.yaml | grep -v '^#') <(grep -v '^#' .github/chainguard/auto-arm.sts.yaml))" = "$(printf '%s\n' '8a9' '>   workflows: write')"
# the comment says why
grep -q 'A11-203' .github/chainguard/auto-arm.sts.yaml
grep -q '2026-10-24' .github/chainguard/auto-arm.sts.yaml
# the pinning test (node strips the types)
node --test src/packaging/auto-arm-octo-sts.test.ts
```
