---
"agent-org": patch
---

A merged pull request's `Partial:` line that only describes the run's own pull requests no longer keeps a finished ticket at Needs you. When its words say the ticket completes when the pull requests have merged (`The ticket completes when both have merged.`), name no step before the last, and every pull request they name is recorded merged, the board reads the body as `Closes`. The pull count used to read a run's declaration is every pull request the run has (the outcome's, the hook's record, and the others the tracker links that are merged or open, less earlier plan steps'), and the declaration waits until none of them is open. A11-370 and A11-254 showed it.
