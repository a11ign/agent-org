---
"agent-org": patch
---

A tick the graph pacing kept off the primary's tracker lanes no longer says they were refused. The lanes were not asked, so `OUTAGE:` no longer fires for them, `claim-stall` no longer logs `could not be read -- NO claim was evaluated` for the open rows, and the offer says `PRODUCT ROW OFFER NOT READ (share X/Y): the open rows were skipped by pacing this tick` in place of `NO PRODUCT ROW OFFERABLE`. A primary lane that was asked and came back refused is still named as refused on the PARTIAL line (a11ign/agent-org#1401). Off with `gate.graphqlPacing`, the same flag as the pacing.
