---
"@a11ign/agent-org": patch
---

A claimed worktree refused for its toolchain names why the claim's install did not leave one: `the claim's install: install failed: <first error line>`, `not ready: <what>`, or `no install ran` when the claim reported none. The outcome is read from the claim's own STARTED line, so a refusal says what the install did instead of only that `typescript` does not resolve (a11ign/agent-org#1265).
