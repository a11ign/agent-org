---
"@a11ign/agent-org": patch
---

A spawn whose engineer brief is not at its absolute path in the home project is refused, `no spawn: the engineer brief is not at <path>`, after the memory and claim prechecks and before the claim (a11ign/agent-org#869, `ceo`'s addition 2 on #850): no row is claimed and no pane is opened, so a pane is never started to be told to read a file that is not there and sit idle on it.
