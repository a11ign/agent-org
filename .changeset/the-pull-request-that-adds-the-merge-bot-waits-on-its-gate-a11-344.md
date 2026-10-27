---
"agent-org": patch
---

The pull request that adds a private repository's merge bot is read as a merge-bot pull request (A11-344). The board took a repository as a merge-bot repository only when its default branch held `.github/workflows/merge-bot.yml`, so the pull request that adds the bot, whose default branch holds nothing until it merges, still had every check counted: auth-capture-check #20 sat with no reviewer for ten hours behind a red `capture` that was no concern of its own. In a private repository with no required check, the board now waits on `gate` alone when the pull request's head (`refs/pull/<n>/head`) holds the bot, as well as when the default branch does. Other checks are listed and reported to the reviewer as an unrequired red. A red `gate`, a ruleset's required checks, a public repository, and a private repository with the bot on neither the default branch nor the head are read as before. The pull request's first merge stays a person's (A11-291).
