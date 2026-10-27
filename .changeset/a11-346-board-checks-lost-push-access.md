---
"agent-org": patch
---

A worker's hand-back on lost push access no longer reaches a person unchecked (A11-346). Before the card is raised the board pushes the run's branch itself from the run's checkout, with a dry run and then a real push, tried twice. A push that works is logged on the run (a `push-check` event, drawn on the Timeline), the worker is woken with "access is fine, carry on", and no card is raised; a push that fails twice keeps the card with git's error after the worker's reason and in the log. Every worker brief now says that `permissions.push` reads false under an App installation token and is not evidence, to retry a failed push once, and to quote the full `remote:` lines.
