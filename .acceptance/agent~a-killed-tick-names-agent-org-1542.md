A killed tick's wake names the phase it was in. `phaseMarker` (`src/work-tick-health.ts`) is handed each phase's name as `createMeter` begins it (`begun`, before the wall is taken), and rewrites the start marker with the same start and `phase` and `phaseAt`. Every rewrite goes through a temporary file and a rename (`writeStartMarker`), so a reader sees the marker before a boundary or after it, never half of one. `readMarker` takes `phase` and `phaseAt` only as a pair (a marker an older tick wrote has neither). `killedTickOrders` puts the phase first when there is one: `It was in phase "<name>" for at most <m s>`, the span from `phaseAt` to the finding instant, then the unit's own journal from that time, then the cost lines, as it always said. A marker with no phase says `No phase was recorded` and keeps today's advice. The causeKey is unchanged. `startRun` (`src/work-tick.ts`) takes the start once (`Run.start`), so the start marker and every phase rewrite agree on it. A phase write that throws never fails the tick: the first refusal is said once on stderr (`TICK PHASE NOT RECORDED`), and a killed tick after that has no phase to name.

Acceptance: `node --test src/work-tick-health.test.ts`

Mutation: the reader made to name no phase (`const named = false`) failed 4 of 45 tests: the phase-naming control, the whole-marker control, the phase-write-refused control, and the through-the-tick SIGKILL test (whose marker names no phase). The temporary-file write made to write the marker in place (`const temporary = path`, which also changes the tick record's writer, the same convention) failed the whole-marker test only. Both were restored from a copy and diffed clean.

Control (a) on `origin/main`: the health module there does not load this test file (`phaseMarker` is not in it), so the check ran the marker through main's `work-tick-health.ts` from a scratch export: a marker `{at, pid, phase: "recover", phaseAt}` reads back with no phase, and the killed-tick prompt contains neither `recover` nor `8 m 31 s`. The same marker through this change does both (the first test of the file).

Measured: `node --test src/work-tick-health.test.ts`: 45 pass, 0 fail (41 before, plus four new tests; the through-the-tick SIGKILL test gained two assertions). `pnpm run typecheck`: exit 0.

Not run: `pnpm run lint`, `pnpm run verify` and `pnpm run test:org` are not defined in this worktree's `package.json`. The rstest changed-set (`npx rstest run --config scripts/rstest/rstest.config.ts --changed=origin/main`, the set `verify` runs) has 108 failing tests in 22 files (work-gate, pr-owner, org-health and related). The same 22 files, run with this change's three files replaced by their HEAD versions, fail the same 108 of 736, so these predate the change and are not in this row's Region.

Not here, and named: the 23:22:47Z tick's stall is not investigated (out of scope); no wall-time budget after the gate (out of scope); the marker records the last phase BEGUN, not the phase that finished, so a tick killed inside a phase is named as in it. `host:install` is the host's step and was not run.

Closes a11ign/agent-org#1542

platform: linux, Node v24.21.0; the marker is a file under the tick's ledger directory, and the tests run in temporary directories.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
