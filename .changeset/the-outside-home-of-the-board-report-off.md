---
"agent-org": patch
---

The outside home of the board report, shipped OFF behind `outside.board` (agent-org#1574, of "agent-org stands alone"). `.github/workflows/board-outside.yml` runs `board:report`, `board:document` and `board:summary-check` on the project's `main` from this repository, with an Octo STS token for the project, only when the project's `.agent-org/decisions.json` says `"outside.board": true` (absent is off). With the flag on, a SCHEDULED run that finds the day's edition already written (the `# Board report — <day>` comment, the day's Discussion) writes nothing, so the project's own job and this home can both run and the second does nothing; a dispatch is never skipped. `board-discussion --outside-on` reads the flag by exit code. A project that pins a tag changes nothing until it sets the key.
