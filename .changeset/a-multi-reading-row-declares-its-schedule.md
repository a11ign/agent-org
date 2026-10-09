---
"agent-org": minor
---

A row can declare a multi-reading schedule as `Reading: <n> at YYYY-MM-DDTHH:MM:SSZ` lines, and `waitingOn` (given the row's `comments`) reports the next reading with no `Reading <n> posted` receipt as the row's date wait, superseding `Not-before:`; when the last receipt lands the wait is gone. A row with no `Reading:` line, or a caller that passes no comments, gets today's answer. The gate's row listing does not carry comments yet, so wiring them in is a follow-up. a11ign/a11ign#4638.
