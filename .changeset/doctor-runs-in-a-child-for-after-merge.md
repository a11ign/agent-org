---
"agent-org": patch
---

The After-merge sweep reads this host's doctor from a child process (A11-377). The doctor's checks spawn synchronously: they mint each App role's token, run `claude mcp list` and ask pnpm its version. On the board's thread they held its loop for seconds on each read. On agents-ts that was `wrapper.ts:136`, `doctor.ts:431`, `doctor.ts:436`, `doctor.ts:1125` and `linear/checks.ts:52`, 367 of 683 held-loop lines in three hours. The child takes about 7 s, and the board's loop runs on meanwhile.
