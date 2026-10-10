---
"agent-org": patch
---

The retro's DORA read no longer reads a repository's lead time, change failure rate and time to restore as `unknown` because the tag reads spent its time budget. A tag repository's release commits are now read from the clone `host.json` declares, in one `git for-each-ref` for every tag, instead of one `gh api .../commits/<tag>` call per release (409 calls and 218 s for `a11ign/agent-org`, which left the merged pull request list 17 s of its 240 s); only a tag the clone does not hold, even after the one fetch of its tags, is asked of GitHub. And an `unknown` that a limit caused now says which limit: `timed out after 90 s` for a call that ran its own, `timed out after N s, all that was left of this repository's read budget` for one given only the rest of the budget, and `was not started: this repository's read budget is spent` for one never begun, where all three read `hit its time limit`.
