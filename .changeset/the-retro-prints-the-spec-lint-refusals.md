---
"@a11ign/agent-org": patch
---

The retro's report has a new line, "Rows refused by the spec lint (24h)", on the line after the underspecified-stops line (a11ign/agent-org#1056, follow-up to #1017). It counts the spec lint's refusals of the last 24 hours: the distinct rows refused, the findings refused, and the count by field (`files`, `run`, and so on). A ledger that cannot be read prints `unknown`, never `0`. The refusals were already written to the failure ledger, one line each, and nothing read them, so a lint that refused too much was invisible. The kind is now defined in `failure-ledger.ts`; `row-file.ts` still exports it, so an importer of `row-file.ts` keeps its name.
