---
"@a11ign/agent-org": minor
---

`node src/gh-ledger.ts <ledger> --by-read` groups the gh-call ledger's reads by the caller script, the subcommand, the repository and the arguments' digest, and prints each group's hits and its misses by reason (`absent`, `generation-moved`, `no-snapshot`, ...), so the question a poller asks again and again is one line, not one line per call. `--account` and `--resource` narrow it. A line whose verdict is missing or not the wrapper's grammar is counted as `(no verdict)` and never guessed at, and a call the cache did not look at is counted only in the header.
