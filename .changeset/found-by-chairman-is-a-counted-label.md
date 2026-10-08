---
"agent-org": patch
---

The board document counts the rows the chairman found, with the target zero beside the count. A row labelled `found-by-chairman` is counted in the UTC week its opening falls in (the seven whole UTC days before the run's day), and the line names the rows and the previous week's count with `better | worse | same | no baseline | unknown`. A refused read, or a labelled row whose opening cannot be read, prints `unknown` and never `0`; a week that begins before the label's first use (2026-10-02) has no baseline. The line sits in the appendix's source table, which the body's word cap does not cover. `ISSUES_QUERY` now reads `createdAt`. a11ign/a11ign#4124.
