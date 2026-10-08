---
"agent-org": minor
---

`agentArgs(profile, { headless: { maxTurns, maxBudgetUsd } })` (`worker-profile.mjs`) returns the launch arguments for a worker run as `claude -p` over stream-json: `--input-format stream-json --output-format stream-json --verbose --max-turns --max-budget-usd --permission-prompts none`, with the model, effort, `--disallowedTools` and `--settings` the pane form already carries, and without `--dangerously-skip-permissions` or `--autocompact`. Without `launch.headless`, which is every caller, the arguments are the pane form byte for byte; the caps have no default and a codex profile or a cap that is not a positive number (a whole number for turns) is refused. No `PROFILES` entry carries the switch and nothing in the tool turns it on, so nothing changes for an installed host (a11ign/a11ign#4075, #4055 move 9). `--max-turns` is accepted by `claude` 2.1.294 but absent from its `--help`.
