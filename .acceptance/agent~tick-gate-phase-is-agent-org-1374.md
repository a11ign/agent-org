Acceptance: `git ls-files 'docs/gate-phase*.md' | grep -q .`

Mutation: the same pattern with the name misspelt (`docs/gate-phasee*.md`) exits 1 on this tree, so the command matches the profile file and nothing else.

Measured: before `git add docs/gate-phase-profile.md` the Acceptance exits 1; after it exits 0. The profile is `docs/gate-phase-profile.md`: 401 ticks in the first 401 lines of `tick-cost.jsonl` (2026-10-14T17:55Z to 2026-10-15T09:02Z, the window the host still holds; the 13th's window was rotated out). Tick wall p50 123.1 s, p95 187.3 s; gate p50 102.2 s, p95 128.5 s. Largest sub-cost `deadMansSwitch+retrospective` (p50 29.4 s, p95 32.8 s per tick), next `orgHealth` (p50 19.1 s, p95 24.3 s). Its row is a11ign/agent-org#1374.

Outside-Region: none.
