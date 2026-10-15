---
"@a11ign/agent-org": patch
---

A seat parked on the Claude limit menu (its pane offers "Stop and wait for limit to reset" and "Switch to usage credits") is freed by the tick once the reset in its transcript has passed: the tick sends it `esc` and nothing else, and says one line, `freed N seats from the limit menu: <labels>`. A menu seat is no longer told the declare-or-decide text, which kept a whole org blocked after the allowance came back (a11ign/agent-org#1412). Off with `gate.accountLimitPause`, the same flag as the account pause.
