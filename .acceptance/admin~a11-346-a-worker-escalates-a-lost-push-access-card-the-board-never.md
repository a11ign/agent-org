## What it is

On 2026-10-27 A11-229's worker ended `needs-human` under the access item because a `git push` got a 403 and `gh api repos/<repo>` read `permissions.push=false`. That field reads false for every repository under an App installation token, and the 403 was transient: a push from the worker's checkout worked 35 minutes later, after the card had sat in Needs you.

Now an access hand-back whose reason says a push was refused or the right to push is lost (`claimsLostPush`) is checked by the board before it ends the run. In each checkout of the run the board runs `git push --dry-run` and then a real `git push` of `HEAD` to the ticket's branch (hooks off, a timeout of two minutes each), and tries the pair once more when it fails. If it works: a `push-check` event is logged on the run, the worker's pane is prompted "access is fine, carry on", its old outcome is marked stale, and no card is raised. If it fails twice: the card stays, with git's error (the `remote:` lines whole) after the worker's reason and in the `push-check` event. A worker already woken once that hands back on access again gets its card. A hand-back that is not about pushing, and a run with no checkout, are not checked.

The escalation rule every worker, planner and reviewer brief quotes now says `permissions.push` is not evidence under an App installation token, to retry a failed push once and to quote the full `remote:` lines.

## Acceptance

- The board's push succeeds: no Needs-you card, the worker is woken, the check is logged (`pool-push-check.test.ts`, first two cases).
- The board's push fails twice: the card stays and quotes git's error (third case).
- The role text names `permissions.push` as not evidence (last case).

Acceptance:
```bash
set -e
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-push-check.test.ts src/ticket-mode/escalation.test.ts src/ticket-mode/escalation-stop.test.ts src/ticket-mode/pool-write-retry.test.ts src/ticket-mode/run-log.test.ts
pnpm --dir ui exec rstest run src/run-detail/run-detail-timeline.test.tsx
```

Consumer-declaration: none -- the board's pool is the only caller of the new module, and the Timeline row is drawn from the run log.
