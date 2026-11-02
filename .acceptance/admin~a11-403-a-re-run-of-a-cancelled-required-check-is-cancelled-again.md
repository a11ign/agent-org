## What it is

Step 3 of 3 of A11-403, which completes it. One push to a pull request started two `ci` runs: the push's, and one for the body edit that followed it seconds later (`edited` was in `ci.yml`'s `pull_request` types). Both ran in the group `pull-request-<n>`, so the second cancelled the first, and the board's rerun of the first then cancelled the second (a11ign/agent-org#2017). `edited` is gone from `ci.yml`. `.github/workflows/pr-body-edit.yml` keeps the repair a body edit used to give (a `no-release:` line added to the body turns the `changeset` job green) without a second run: on a body edit it waits for the head's `ci` run to complete and reruns its failed jobs only when the `changeset` job or the Closes check failed. The Closes step of `ci.yml` and the shared `changeset` job (pinned to the toolchain commit of step 2) read the body live, because a rerun replays the event payload.

## Acceptance

`src/ci-one-run-per-push.test.ts` fails if `edited` is in `ci.yml`'s `pull_request` types or any step of `ci.yml` reads `github.event.pull_request.body`, holds `pr-body-edit.yml` to its trigger, permissions, group and conditions, and runs the repair step's shell for real over a stand-in `gh` (waits for the run, reruns on a body failure only, never on another red, a moved branch, a cancelled run or a timeout). `src/ci-stacked-triggers.test.ts` holds that `merge_group` stays and `edited` does not. The live checks (one push and one body edit show one `ci` run; a body fix turns `gate` green) are in the pull request body.

Acceptance:
```bash
set -e
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ci-one-run-per-push.test.ts src/ci-stacked-triggers.test.ts src/ticket-mode/pool-stacked-review.test.ts
node .github/scripts/workflow-paths.ts
```

Consumer-declaration: none -- no option is added: a workflow, its tests and a comment.
