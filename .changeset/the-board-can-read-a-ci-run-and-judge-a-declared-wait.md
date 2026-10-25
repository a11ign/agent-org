---
"agent-org": patch
---

The code host contract is 1.17: `readCiRun(repository, runId)` is a new OPTIONAL operation that reads a workflow run (its status, conclusion, address, name and the jobs completed of all it lists), and the GitHub plugin answers it with `gh run view`. A plugin of 1.16 is read as one with no CI-run read. The board also gains, unused until the next release, the reads and the verdict for a worker's declared wait (`waitingOn` and `until` of a `working` outcome): nothing in a run changes yet.
