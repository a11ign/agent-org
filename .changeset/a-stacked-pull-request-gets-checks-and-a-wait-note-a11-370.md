---
"agent-org": minor
---

A pull request stacked on another branch has checks, a review and a card that says what it waits on (A11-370). `ci.yml` ran only on pull requests to `main`, so agent-org#1984, stacked on #1982, got no checks, its reviewer (which starts on green checks) never started, and nothing on the board said why: the `pull_request` trigger now has no base filter, and `main` stays behind the merge queue's `merge_group` run. The runs page says `waits on #<base> (<state of the base>)` on a stacked member and `#<n> (<ticket>) is stacked on it` on the base (`board-view/stack-wait.ts`), and a queued run that has a pull request stacked on it starts before the other queued runs of its model (`nextStarts`).
