---
"agent-org": minor
---

The board reruns a red job once before it asks a worker (A11-300). When a required job is red at a head, the watch reruns that run's failed jobs (`gh run rerun --failed`) and starts a worker round only if the job is red again; a run whose other jobs are still going is waited for, since GitHub reruns the failed jobs of a finished run only. A job that passes on rerun is recorded as a flake in `flakes.json` in the board's state (the test or step that failed, the run and the head), and a test that flakes three times in seven days is listed on the Runs page's pool bar (`GET /api/flakes`) and as a `flaky tests` warning in `agent-org doctor`, for the chairman's session to file a ticket for. A round that ends with no push and a worker's reply that says the failure is unrelated to the change ends in one rerun of the failed jobs, and a person decides if it is red again.
