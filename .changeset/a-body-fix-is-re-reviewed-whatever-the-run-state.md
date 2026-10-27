---
"agent-org": patch
---

A pull request whose description is edited to answer the reviewer's block is now looked at again within one sweep, whatever state its run is in (A11-274). Before, the board waited for the run to finish, and counted the edit only when the run's round ended after the block. A run that had stopped without an outcome, or was waiting in its terminal, never got that round, so the fix sat unreviewed. The re-review now waits only while the worker is working. It still counts as one of the run's rounds, and at the cap the run is handed to a person. A parked run that stopped without an outcome is also let go once its pull requests merge, as a `needs-human` one already was, so its next step is queued or its ticket completed.
