---
"@a11ign/agent-org": patch
---

`agent-org trace -- --aggregate` prints a "by tracker" block for each complete week: merged rows, turns and dollars for product and for org, read from each merged row's Region (a11ign/agent-org#4081). A turn whose rows are of both trackers, or whose row's Region was not read, is UNCLASSIFIED and is never guessed. A standing lead's no-row turns stay inside overhead, printed as "standing seats, not attributed", and are not split by any ratio. Every week also prints the identity "every turn of the week = product + org + unclassified + UNMEASURED + UNPLACED + overhead", so the parts can be checked against the total. `aggregate` takes `trackerOf` (a map of merged-row number to tracker class); a run that does not read Regions puts every merged row in unclassified.
