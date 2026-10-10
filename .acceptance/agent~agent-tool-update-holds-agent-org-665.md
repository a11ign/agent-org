`agent-tool:update` refuses only for a mid-turn seat that runs a tool this run is about to move: a reviewer holds a move of `codex-cli`/`codex-daemon`, a Claude seat holds a move of `claude-code`, and a seat whose label matches neither rule is held for every tool being moved (a11ign/agent-org#665).

Acceptance:
```bash
cd /home/agent/repos/wt-agent-org-665 && npx rstest run --config scripts/rstest/rstest.config.ts src/agent-tool-update.test.ts
```

Run in this branch's tree through the main clone's `node_modules` (a symlink, no install). Printed: `VERDICT pass: 30 tests in 1 file`; `node --test src/agent-tool-update.test.ts` agrees (`tests 30, pass 30, fail 0`).

Against `HEAD`'s unmodified `src/agent-tool-update.ts` the new file cannot load (`does not provide an export named 'productOfSeat'`). With `HEAD`'s logic and the two new exports stubbed so it loads: `tests 30, pass 22, fail 8`, the six new `#665` cases and the two reworded refusal cases among them.

Mutation (each restored from a copy):
- every label not starting `reviewer` read as `claude`, so an unknown seat is never held: 2 of 30 red (the unknown-label case and the rule case).
- `toolsHeldBy` returns every tool being moved, so every mid-turn seat holds as before: 5 of 30 red.

Typecheck: `tsc --noEmit -p tsconfig.json` (the main clone's binary) reports no error in either file.

Assumption: the row's "every other seat runs `claude`" and "a label matching neither rule is held" cannot both hold for a label like `smoke-reviewer-…`, so the Claude rule is the positive one the row's own text names (`ceo`, `orchestrator`, `product-manager`, `worker-…`) and everything else is unknown and held. A bare `reviewer` is read as Codex, as `reviewer-…` is. A new Claude role is held until it is added to `productOfSeat`; that errs towards a refusal, not a move.

Not run: the live command (a11ign#4825); `orchestrator` re-runs it after the release carrying this change.
