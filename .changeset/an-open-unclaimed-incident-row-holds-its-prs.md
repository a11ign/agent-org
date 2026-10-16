---
"agent-org": patch
---

A shared-failure hold no longer lapses at 15 minutes while its incident row is open and unclaimed. The held pull requests wait for the row to close, so no worker is woken for a failure the row was filed to keep them from diagnosing separately. A closed row still releases them at once, and an unclaimed open row past 15 minutes is named once in the gate log.
