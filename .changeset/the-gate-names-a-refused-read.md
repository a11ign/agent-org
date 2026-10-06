---
"agent-org": patch
---

The gate names a refused read of one sha, and a stale evidence head says nothing (a11ign/a11ign#3724). `readPatchId`, `readCommitShas` and `readFailingChecks` handled a refusal and returned `null`, but `defaultRun` inherits stderr, so `gh`'s own bare `gh: Not Found (HTTP 404)` reached the journal beside it, naming no repository, pull request or sha (30+ ticks from one review of a11ign/lab#4 naming a head a force-push had removed). The three now read with `gh`'s stderr captured. A 404 or 422 on a compare or commit path is a sha that resolves to nothing and prints nothing: the pull request is read at its head alone, as before. Any other refusal (403, 5xx, a timeout, a 404 of a pull request's commits) is ONE line per tick naming the repository, the path (the sha elided, so every head is one line) and the status. Every other `gh` call is unchanged, and no call or phase is added (#3566's freeze).
