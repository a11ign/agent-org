A Haiku start that fails CI twice, or reaches its turn or compaction cap, is restarted on Sonnet at high effort, once per row. `src/engineer-escalation.ts` is the pure decision (`shouldEscalate`, caps 2 distinct red heads / 10 compactions / 300 turns, a Sonnet or unknown model and an unreadable figure never escalate); `performEscalations` in `src/wake.ts` is where the tick reads a live Haiku start's claim record and transcript, closes the pane, records an `escalation` line (the once-per-row pin, which survives a restart that died half way), writes the `use: model-escalation`, `via: none` decision-log line and a row comment, and respawns through `spawnWorker` with the claim neither released nor re-won and a line in the brief saying why. The row keeps `tier:haiku`. The `arm` line now carries `model` (two arm-line deepEquals in the existing wake tests were updated for it).

Evidence (measured on this branch at agent-org `f8b51b9` plus this change, `AGENT_ORG_HOST` set to the a11y-witness checkout's `.agent-org/host.json`): `src/engineer-escalation.test.ts` 37 tests pass; `src/wake*` 229 tests in 18 files pass; `tsc --noEmit` shows only the two `mjs-ratchet.test.ts` errors that `origin/main` already has. No provider, network or corpus in the test: the SEAM tests drive `performEscalations` with a fake herdr and fake `gh`.

Mutation in both directions, 11 mutants, each killed by a test, every source file restored byte-identical (`cp` backup and `diff`): M1 Sonnet start escalates too; M2 cap `>=` read as `>`; M3 once-per-row ignored; M4 `capReached` always returns a reason (control side); M5 a `null` count counts as a hit; M6 the escalation recorded BEFORE the Haiku pane closes (a close that failed would then be unretried); M7 no route override, so a later gate respawn is Haiku again; M8 the arm line drops `model`; M9 the restart releases the claim; M10 the brief carries no note; M11 the compaction cap forgotten.

Done-when 2 (read-only over today's open `tier:haiku` claims, 2026-10-09): there are none. `gh issue list --label tier:haiku --state open` returned `[]`, the claim-orders record has 345 `arm` lines and none names a Haiku model (they predate this change, so none carries `model` at all), herdr lists 15 agents, none a Haiku start: `WOULD ESCALATE: []`. A fixture run of the real `performEscalations` over a typed record (worker-5001 Haiku with two red heads; 5002 Haiku at 10 compactions; 5003 Haiku with one red and 40 turns; 5004 Sonnet with three reds, 500 turns, 12 compactions; 5005 Haiku at 300 turns) wrote:
  ESCALATED #5001: its pull request has failed CI 2 times (the cap is 2): restarted on Sonnet/high, the claim, branch and worktree unchanged.
  ESCALATED #5002: it has compacted 10 times (the cap is 10): restarted on Sonnet/high ...
  ESCALATED #5005: it has used 300 turns (the cap is 300): restarted on Sonnet/high ...
  (5003 and 5004 untouched; herdr calls per escalated worker: `workspace close`, `workspace create`, `agent start ... --model sonnet --effort high`, `agent prompt`; three decision-log lines `{"use":"model-escalation","via":"none","fellBack":false,"outcome":"escalate",...}`, three `escalation` record lines, three row comments; a second tick over the same record returned `{"lines":[],"busied":[]}`.)

Assumptions: the 300-turn cap is the author's choice, from the 2026-10-09 local trace store (1,182 worker sessions: p50 118, p90 372, p95 512 turns; the 14 Haiku trial sessions peaked at 129 turns and 1 compaction), and the decision log's `escalate` lines are what to tune it from. Compactions escalate AT 10, where the report's stop rule trips above 10, so the per-row decision lands before the report's stop. A "CI failure" is a distinct red head the worker was told of since its newest `arm` line.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/engineer-escalation.test.ts`

Mutation: 11 mutants, each killed by a test, both directions (Sonnet start escalates; cap `>=` read as `>`; once-per-row ignored; always-escalate control; null count as a hit; escalation recorded before the pane closes; no route override; arm line drops `model`; restart releases the claim; brief without the note; compaction cap forgotten). Sources restored byte-identical with `cp` and `diff`.

Closes a11ign/a11ign#4630

platform: n/a (tick logic over a recorded file, with a fake herdr and gh)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
