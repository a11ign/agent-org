---
"agent-org": patch
---

`callerScript` names the unit behind a preload and a session's shell for what it is (a11ign/a11ign#3590). It took the FIRST `*.mjs` in the caller's command line, so a unit started as `node --import file:///.../crash-exit.mjs /.../work-gate.mjs` or `node --import=./src/lib/crash-exit.mjs src/work-tick.mjs` read `crash-exit.mjs` (2,756 of one host ledger's 7,510 calls), and a session's `zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<ms>-<id>.sh` read as its snapshot file, one name per Claude Code process. `callerScript` now skips `--import <module>` and `--import=<module>` and names the shell `(a session's shell)` (exported as `SESSION_SHELL`), so `topCallers` and the trace ingest agree; the two lines `src/trace/gh-calls.ts` kept to work round this are deleted.
