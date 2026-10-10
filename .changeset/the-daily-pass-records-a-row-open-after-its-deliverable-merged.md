---
"agent-org": minor
---

The daily pass records a row left open more than 30 minutes after its deliverable merged as a `row-not-finishable` ledger incident. `org-retro` reads every declared tracker's open rows and every declared code repository's merged (last 7 days) and open pull requests, takes a pull request's deliverable from its `Closes` list, a `Closes: none` reason that names the row, or the branch the row's claim record names, and prints `Rows still open more than 30 minutes after their deliverable merged: N; first: ...` in the report. One episode is one ledger line, keyed `<tracker>#<row>@<repo>#<pr>`. A list that could not be read makes the line `unknown`, never 0. Epics and rows another open pull request also names are not incidents.
