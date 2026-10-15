A probe of an ended seat writes nothing to the work tick's journal: `herdr` answers `agent_not_found` / `pane_not_found` for every seat that has ended, and the herdr runner now captures the child's stderr and re-emits it only when it is a refusal other than "gone" (`src/herdr-agents.ts`). The three spawn sites in the Region (`src/wake.ts`, `src/herdr-agents.ts`, `src/work-gate/reads.ts`) go through that runner. A "gone" answer still rides on the thrown error for the callers that read it, and a refusal that is not "gone" (`agent_blocked`) still reaches stderr.

Acceptance: `node --test src/wake-herdr-stderr.test.ts`

Mutation: the runner made to inherit stderr (the pre-change behaviour) failed the three gone/thrown tests and passed the control; the re-emit made never to fire failed the control only; the re-emit made always to fire failed the three gone/thrown tests. `src/herdr-agents.ts` restored byte-identical each time (`diff` against a copy).

Measured: `pass 4 / fail 0` for the acceptance file; `pnpm run typecheck` exit 0. Full `pnpm test` shows 113 failing tests in 26 files, all network/GitHub-dependent (gh 502, rate limits); the same failing names occur on a clean `git archive` of origin's HEAD, so they predate this change, and no herdr-related test file fails.

Not here, and named: other herdr spawn sites outside the Region still inherit stderr (`src/crash-recover.ts:348`, `src/fleet-gated-nightly.ts:60`, `src/host-units.ts:3210`, `src/prompt-session.ts:55`, `src/ticket-mode/pool.ts:51`, `src/worker-state.ts:284`). They are outside this row's Region and are reported on the row, not changed in this PR.

Closes a11ign/agent-org#1487

Row: a11ign/agent-org#1487 (done-when 3, the two registered ghosts and the queued order for `worker-agent-org-1325`, is posted on the row; nothing is deleted in this PR).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
