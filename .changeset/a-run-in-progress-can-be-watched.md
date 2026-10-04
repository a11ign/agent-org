---
"agent-org": minor
---

A run in progress can be watched with `chairman:watch add run <id>` (a11ign/a11ign#3502). Its state is the new vocabulary field `{{run:<id>.status}}`: the run's status (`queued`, `in_progress`) while it runs and its conclusion once it has one, so each move is told and the watch ends with the conclusion. Until now the only run field, `{{run:<id>.conclusion}}`, threw for a run that had not concluded, so `add` refused the one case a watch is for; that field is unchanged. The liaison's brief restates the vocabulary, so a project that pins it learns `run:<id>.status` from `PLACEHOLDER_NAMES`.
