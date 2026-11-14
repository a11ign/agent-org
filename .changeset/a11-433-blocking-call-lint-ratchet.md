---
"agent-org": patch
---

Lint now refuses a new synchronous spawn (`spawnSync`, `execFileSync`, `execSync`) or synchronous herdr call in `src/ticket-mode/` and `plugins/` (A11-433). `blocking-calls.baseline.json` lists the files that still make one, and that list only shrinks. It also names, with a reason, each CLI entry point a person runs, which may block. The lint cache key now includes that file.
