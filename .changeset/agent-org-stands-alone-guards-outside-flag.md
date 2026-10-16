---
"agent-org": patch
---

The outside home of a11ign's `guardSweep` reads the flag `outside.guards` and ships OFF (#1580). `shadowGuardsVerdict` asks for no verdict unless the flag is a literal `true`; on, it records the org-side tree-wide-guard verdict beside the job's and blocks nothing.
