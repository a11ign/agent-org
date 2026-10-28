A run whose worker wrote `working` and waits on a pull request (`waitingOn` a pull request) is told at once, with one prompt for each head, when that pull request has a review asking for changes at its head, a red required check or a conflict: the idle run is not left to wait for the `until` of a merge that cannot come. A pull request the run opened (the PostToolUse hook records the address a `gh pr create` or `pr:open create` printed) is kept on the run, among its pull requests, and watched the same way, whatever its outcome lists. A changes-requested review that stands for an hour with the worker idle ends the run `needs-human` naming the pull request and whether the worker was told, so it reads Needs you.

On a machine with `tickets.drafts: false` the ready mark is given to every ticket run, a round that answers feedback included, so the worker may open a ready pull request, and the hook lets it mark its own pull requests ready (`gh pr ready` with no argument, or with the URL of one it opened). A machine that keeps drafts is unchanged: a worker opens a draft and only an approved review run marks the person's chosen pull requests ready.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-wait-pulls.test.ts src/ticket-mode/hook.test.ts
```

Consumer-declaration: none -- no host file changes meaning. The queue file gains two optional fields (`opened` on an entry, `fed` on a `working` note), which an older queue simply does not have.
