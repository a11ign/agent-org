---
"@a11ign/agent-org": patch
---

`denialShape` names `nested-shell-c` for a `bash|sh|zsh|dash|ksh -c` whose script holds a `$` or a backtick, whether or not an `rm` is in it, so a denied nested shell with no removal in it is no longer `other` (agent-org#1275). The shell set and the `-c` option form match the PreToolUse hook `refuse-unreadable-command.ts`.
