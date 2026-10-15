---
"@a11ign/agent-org": minor
---

A wake event in the trace store says what the wake did. `outcome` is `wrote`, `no-op` or `escalated`, or `null` when the store cannot tell, and `runId` is the session that ran it (agent-org#487, Move 0 of a11ign/a11ign#4505). `wrote` is a `gh issue|pr` write verb in the session's own window (the ledger, or the turn's command text), a file edit or a `git commit|push`; `escalated` is a `prompt:session` to another session with no write; `no-op` is neither, and is only said where nothing could have been hidden: a window whose ledger hour the store is not short of, whose turns' `gh` commands the ledger also holds, with no call whose verb the ledger does not keep (`gh api ...`) and no send of an unnamed sender. A wake that wrote and escalated is `wrote`. A window the store cannot read is `null`, never `no-op`. Outcomes are written in one batch once the oldest settle-able wake is three hours old, because a supersede rewrites the whole store.

`trace -- --wake-outcomes [--since <ISO>] [--until <ISO>] [--store <path>] [--json 1]` prints the split per cause over a window, with `null` on its own line and the wakes not yet settled counted inside it.

Every turn now carries `repoWrite` (whether it edited a file or ran `git commit|push`) and `ghCommands` (how many `gh` commands its text named). The ingest state is version 6, so the next `--ingest` is a cold start that reads each transcript again and supersedes the stored turns with them; until it has, a wake whose turns lack them is `null`, which is why a `no-op` is not said of one.
