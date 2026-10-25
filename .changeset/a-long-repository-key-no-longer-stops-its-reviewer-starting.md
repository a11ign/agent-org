---
"agent-org": patch
---

A reviewer for a repository with a long key starts. herdr refuses an agent name over 32 characters, and `reviewer-announcement-emulator-11` is 33, so no announcement-emulator pull request from #10 on was ever reviewed. One function, `herdrAgentName`, now names every herdr agent: a name herdr accepts is unchanged, a longer one is shortened to 32 characters or fewer with a hash of the full name, and the workspace keeps the full label the board and the terminal show. Every `agent` call (start, prompt, read, get, wait, send-keys) passes its label through it, and a refusal of the start quotes herdr's own reason (A11-241).
