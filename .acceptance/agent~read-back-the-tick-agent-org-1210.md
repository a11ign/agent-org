Acceptance: `git ls-files 'docs/tick-budget-read*.md' | grep -q .`

Mutation: the same pattern with the name misspelt (`docs/tick-budget-readbak*.md`) exits 1 on this tree, so the command matches the reading file and nothing else.

Measured: before `git add docs/tick-budget-readback.md` the Acceptance exits 1; after it exits 0. The reading is `docs/tick-budget-readback.md`: 410 ticks in `tick-cost.jsonl`, tick wall p50 104.8 s, p95 199.0 s, so the named phase is `gate` (p95 105.8 s) and its row is a11ign/agent-org#1374.

Outside-Region: none.
