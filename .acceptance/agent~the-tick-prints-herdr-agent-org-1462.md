A probe of an ended seat writes nothing to the work tick's journal from any `herdr` call site in the tick. Every `execFileSync("herdr", …)` outside the shared runner (`src/herdr-agents.ts`, from #1487) now goes through `herdrRun`: `src/worker-state.ts` (`paneOf`), `src/prompt-session.ts` (`defaultRun`), `src/host-units.ts` (`liveClaudeSessions`), `src/crash-recover.ts` (the herdr-agents and ports reads), `src/fleet-gated-nightly.ts` (`defaultHerdrRun`) and `src/ticket-mode/pool.ts` (`defaultHerdr`). A caller that catches a "gone" answer reads the seat as gone and the tick's stderr stays empty; a caller that lets it escape still gets it thrown; a refusal that is not "gone" (`agent_blocked`) still reaches stderr.

Acceptance:
```bash
bash -c '! git grep -q -E "execFileSync\(.herdr." -- src ":(exclude)src/herdr-agents.ts" ":(exclude)*.test.ts"'
node --test src/wake-herdr-stderr.test.ts
```

Mutation: the host-units caller reverted to its inherited-stderr form (`execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 })`) failed the two catching-caller tests (`pass 5 / fail 2`). `herdrRun` made never to re-emit (`if (false && …)` in `src/herdr-agents.ts`) failed only "a refusal other than 'gone' is still written". `herdrRun` made to re-emit every refusal failed the five tests that need silence. `defaultRun` in `src/prompt-session.ts` made to swallow its error failed the escape test. Each mutated file was restored byte-identical (`cmp` against a copy taken before the edit).

Measured: the acceptance grep exits 0 (it exits 1 at the old main, which has six matching lines outside the runner); `node --test src/wake-herdr-stderr.test.ts` passes 7 of 7; `pnpm run typecheck` exits 0. A focused `rstest` run over the 82 test files that import or name the touched modules has 41 of 2579 tests failing in four files: 37 in `src/packaging/work-gate.test.ts`, 1 in `src/packaging/host-install-agent-org-launcher.test.ts`, 2 in `src/packaging/live-tree-independence.test.ts` (`Cannot find module 'tsx/package.json'`: `tsx` is neither declared in `package.json` nor installed in this checkout), and 1 in `src/tmp-fixtures-are-removed.test.ts`, whose live reading runs `src/packaging/pr-open-requires-verify-stamp.test.ts`, and that file's three `#3215` tests fail the same way on a clean `git archive HEAD` export without this change. The gate and launcher failures are gh network and rate-limit failures that also appear with the change reverted (a full run at baseline failed 109 tests in 23 files, the same failing names). None of the failures is in a herdr test. Platform: linux, the agent host.

Not here, and named: the post-merge journal read (`journalctl --user -u a11ign-work-tick --since -1h -o cat | grep -c agent_not_found`, reads 0 for non-live seats) needs the tick to run after merge and is posted on the row after merge, not in this PR.

Closes a11ign/agent-org#1462

Row: a11ign/agent-org#1462 (done-when 1 and 2 here, done-when 3 after merge; see the note above).

Flag: none -- the old behaviour is the defect: the inherited stderr printed each ended seat's refusal to the tick's journal, so a flag would keep that print on for the window it is gated.
Health-signals: claims-refused, wakes-held
Revert: revert this PR; the probes go back to inheriting stderr, with no state to undo.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
