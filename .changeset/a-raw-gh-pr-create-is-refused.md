---
"agent-org": minor
---

The `gh` wrapper (`host/gh`) refuses `gh pr create` unless `A11Y_PR_OPEN` is set (a11ign/a11ign#4397), and `pr:open` sets it on its own `gh` child. A raw create skips what `pr:open` does (the session label, the `Acceptance:` and `Closes` check, the Region check), and agent-org#436 was opened that way. **A worker that types `gh pr create` now gets a one-line refusal naming `pnpm run pr:open` and exit 1**; it exits before `gh-real` and before the call ledger, so it writes no line. `pr list`, `pr view`, `pr edit` and every other call are untouched, and a runner (no wrapper, such as the release workflow's own `gh pr create`) is not affected. **`host:install` copies the wrapper, so the refusal reaches a host only when the host operator installs it.**
