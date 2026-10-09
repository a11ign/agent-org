---
"agent-org": patch
---

`node src/trace/headless-pilot.ts --row <n> --named-on <issue> --max-turns <N> --max-budget-usd <D> [--dry-run]` works one named even row as `claude -p` over stream-json in a throwaway worktree off `origin/main` and writes one record (turns, the trace store's dollars beside the CLI's own figure, `result.subtype`, the row's Acceptance exit and `success`) to `~/.cache/a11ign/headless-pilot/<row>.json`. It is hand-run and outside the wake path: it claims, labels and comments on nothing, and a run that ends at a turn or budget cap is written with `success: false`. It refuses an odd row, a row `--named-on` does not list under `Pilot-rows:`, a claimed row, a row whose `## Fleet` is not No, and missing caps. a11ign/a11ign#4184.
