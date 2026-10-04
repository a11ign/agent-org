---
"agent-org": patch
---

`pr:open create ...` and `pr:edit edit ...` no longer reach `gh` as `gh pr create create` (a11ign/a11ign#3357). The command table already supplies the mode (`FIXED_ARGS`), and the program's own usage text spells it, so an author following the usage text lost a turn to a failure that said "nothing was created". `planInvocation` now drops a leading repeat of the table's fixed arguments, so `pr:open --title ...` and `pr:open create --title ...` are the same command; a `create` later in the arguments (a title) is left alone.
