---
"agent-org": patch
---

`chairman:reply`'s closed vocabulary gains four checked facts for the liaison: `{{fleet.workers-up}}` and `{{fleet.workers-down}}` (worker NAMES only, from the two files `fleet-watch` writes, refused when either is more than 130 minutes old or the roster is empty), `{{gate.last-tick.age}}` (the tick's completion record) and `{{release:OWNER/REPO.latest}}` (the newest published release). Each is stamped by the send's `as of`, a failed read refuses the send and names which, and `PLACEHOLDER_NAMES` exports the list so the liaison's brief can be tested against it. `createGhReaders` takes the file paths from its host; `chairman:reply` does not pass them yet, so the fleet and gate placeholders refuse there until it does (a11ign/a11ign#3420).
