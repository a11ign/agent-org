---
"agent-org": patch
---

In a repository whose merge flow is the merge bot (private, holding `.github/workflows/merge-bot.yml`, A11-291) and that has no ruleset, the board takes the bot's condition, `gate`, as the one required check (A11-341). Other checks are read as not required, as in a public repository: they are listed, and passed to the reviewer as an unrequired red, and they never hold a reviewer start or open a worker round (a red `capture` held auth-capture-check #20 for ten hours). A red `gate` reads red as before, and a repository with neither a ruleset nor the merge bot counts every check as before.
