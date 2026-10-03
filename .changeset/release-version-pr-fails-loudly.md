---
"agent-org": patch
---

The release workflow's version pull request step now fails when `gh pr create` fails. It piped `gh pr create` into `tee` under the runner's default `bash -e`, which has no `pipefail`, so the pipeline took `tee`'s status and a pull request that could not be opened (`GitHub Actions is not permitted to create or approve pull requests`) left the job `success` on four runs. The URL is captured first and then printed. `release-safety.test.ts` ran the steps under `bash -eo pipefail`, stricter than the platform, and so could not see it: it now runs them under `bash -e` and asserts the shell is not `pipefail`.
