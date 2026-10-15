Refs #1368: prs.ownerRouting -- a dependency bot's PR's red checks, conflict and not-convinced verdict go to a worker, not ceo (the flag is OFF by default).

Flag: prs.ownerRouting
Health-signals: wakes-held
Revert: turn the flag off (`machinery:flag off prs.ownerRouting --session=<you>`), or revert this PR. With the flag off every order is byte-identical to today.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/dependency-bot-follow-up-routing.test.ts` (6 tests pass; typecheck clean). Run from the worktree, not the primary checkout, which holds the old code (per the #705 precedent).

Open-check: `git grep -n 'UNOWNED_PR_SESSION = ' origin/main -- src/work-gate/pr-orders.ts` gives 1 line.

What changed: `ownerOfPr` names no session for a dependency bot's PR (rung 6), so its three follow-ups were `ceo`'s. A Dependabot PR has no declared author, so it reads as OUTSIDE, and #1325 withheld all of them. With the flag on, `withholdOutsideFollowUps` now keeps its red checks, conflict and not-convinced verdict and addresses them to the `engineers` pool. Every other follow-up of such a PR is withheld as before. The reroute sits inside the filter because a reroute after it would never see the withheld orders. `tick.ts` is not touched.

Mutations, each restored afterwards:
- Return `ceo` (the order as made) for a bot's PR under the flag: 4 of 6 tests red (the three routing tests, and OTHER FOLLOW-UPS).
- Before the change: 3 of 6 red (the three routing tests, each finding 0 worker orders where 1 is expected).

Open, not in this PR:
- The bot's red and conflict prompts still say the fix is "yours to route: re-lane it … or close it". Changing them needs the flag threaded into the prompt builders, and flag-off must stay byte-identical.
- A bot PR refused with CHANGES_REQUESTED still lands in the unowned set order to `product-manager` (`reviewBlockedSetOrder`), since the row's done-when does not name changes-requested.
- Other follow-up causes for a bot PR (draft-convinced-not-ready, verdict-comment-unreviewed, pr-approval-not-counted, stalls) stay withheld under the flag.
- A bot PR carrying a `session:` label is source `label`, so it is still withheld as an outside PR, as before.
- The `engineers` pool resolves to a free engineer per `wake.ts route`, read from code and not live-checked. If none is free, the order waits.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
