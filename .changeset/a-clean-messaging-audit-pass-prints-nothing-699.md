---
"agent-org": patch
---

The messaging audit prints its count line `messaging audit: n checked, m flagged` only when it flagged something (a11ign/agent-org#699). It printed the line on every tick, clean or not, and the repeating-line detector (which normalises digits) read 47 consecutive clean ticks as one repeating fault. A pass that found nothing, including the first-run baseline, now prints nothing; a pass that flagged one or more still prints the line unchanged, and `AuditResult.line` still carries the count for a caller that wants it. A pass that could not do its job (an unreadable ledger or cursor, a cursor that could not be written) still reports why, as before.
