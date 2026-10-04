---
"agent-org": minor
---

`chairman:reply` refuses text that looks like a flag, and has a `--dry-run`. A `liaison` once typed `--session=liaison` (every other org command asks which session it is) and the chairman was SENT it, as a line of its own. The text arrived by a door `parseArgs` does not guard, a `--` separator or stdin, so the check sits on the text after both are resolved: any word that is `--` and a letter is refused with exit 2, naming the token, and nothing is sent or ledgered (a spaced ` -- ` and a rule of dashes are still prose). `chairman:reply --dry-run` runs the same checks and the same readers, prints the stamped text and what each placeholder resolved to, and builds no provider and appends nothing to the ledger: exit 0 for a text that would send, 2 for one that would be refused, with the refusal printed, and a `--to` no inbound line holds is refused as a send would refuse it. Nothing to take: a command that sent text starting with `--` now refuses it.
