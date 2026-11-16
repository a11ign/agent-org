---
"agent-org": minor
---

A worker eval (A11-431, step 1 of 2): `node scripts/run-eval.ts --set <name|file.json>` replays up to 10 merged tickets through a headless worker. Each one runs in a throwaway clone at its base sha, with the current brief, model and effort. It prints, per ticket and in total, whether its check passes, the offline reviewer's verdict, its similarity to the merged diff, the files it touched outside it, its tokens and its wall time. Nothing leaves the machine: pushes land in a local bare repository, git refuses every URL that is not a local path, `gh` and `agent-org` are local stand-ins, and the worker starts with no MCP server. `docs/run-eval.md` says how to use it. The reviewer eval now starts its reviewer through the same `codexReview` (`src/run-eval/codex-reviewer.ts`).
