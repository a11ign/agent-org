A second occurrence of a failure class now files the class row by itself (a11ign/a11ign#4451, move 1b of epic #4437).

- `src/class-repeat.ts`: `readClassRepeat` also reads the `failure-ledger` (a class key with two DISTINCT refs is a repeat; the same ref twice is one standing event, as `repeatsIn` already says) and counts those events beside the closed `class:<id>` rows (`groupByClass`, `occurrencesOf`, `newestOccurrence`). A class with `guard: null`, or whose newest occurrence is inside `CLASS_REPEAT_WINDOW_MS`, is filed ONCE as a `--kind defect` row through `row-file` (milestone "Self-healing org", label `class:<id>`, every occurrence listed, an Acceptance and Open-check that `row-file`'s own validators accept). The filing is remembered in `class-repeat-filed.json` in the state directory, written atomically and only after `row-file` landed, so a failed filing is retried and a filed one is not repeated.
- `src/org-health.ts`: the `class-repeat` order to `ceo` is kept, and now says either `was filed as #N` or `THE CLASS ROW WAS NOT FILED: row-file refused (…)` with the refusal. A class whose filing covers its newest occurrence reads `clear`; an unreadable ledger reads `unknown`, never "no repeats".
- `src/class-repeat-files-row.test.ts` (new, 13 tests): the four behaviours of the row's Acceptance with a fake `run`, plus a third instance, a failed label create, guard-null versus guarded age, a single instance, absent versus unreadable ledger, `row-file` validator conformance, and the generated Acceptance run for real through `sh -c`.
- Filing, the ledger read and the state file are opt-in through `ClassRepeatIo`, so every existing caller (and `class-repeat.test.ts`, unchanged, 19 tests) cannot file or read the host ledger. The one live caller, `work-gate.ts`, passes `liveClassRepeatIo()`; `row-file` is spawned with `A11Y_POLICY_LAUNCH_REASON` set, because `launchGate` refuses the primary checkout otherwise.

Outside-Region: src/work-gate.ts — the one-line live wiring (`readClassRepeat(defaultRun, repoNow(), liveClassRepeatIo())` and its import); without it the code exists and no tick ever files, which is the row's Done-when 2.

**Caveats, not hidden:** (1) the filed row is backlog, with no `--ready`, so a human or `product-manager` promotes it. (2) It carries `class:<id>`, so once CLOSED it counts as an instance of its own class. (3) A refused filing for a guard-null class with an old repeat is retried, and the refusal logged, every tick. (4) The row's Acceptance names `cd /home/agent/repos/agent-org`, the primary checkout, which does not hold the new test file, so it is run in this working tree; the command is otherwise the row's.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/class-repeat-files-row.test.ts
```

Closes: none -- a11ign/a11ign#4451's Done-when 2 is one live tick filing a class row, linked from epic #4437, which can only be read after this merges and the host runs the gate.

Verified (measured in a worktree at this head, `AGENT_ORG_HOST` at `/home/agent/repos/wt-4451/.agent-org/host.json`): `class-repeat-files-row.test.ts` 13 pass and `class-repeat.test.ts` 19 pass; `src/class-repeat*`, `src/org-health*` and `src/work-gate*` together 505 tests in 36 files pass (one `rstest run` of those path filters). `tsc --noEmit` shows only the existing `src/packaging/mjs-ratchet.test.ts` errors (`@a11ign/toolchain/mjs-ratchet` not found in this worktree), none from this diff. The FULL suite was started but had not finished when this body was written; CI is the reading for it.

Mutation: ten single-line mutations of `class-repeat.ts` / `org-health.ts` were run one at a time against `class-repeat-files-row.test.ts` + `class-repeat.test.ts`, each breaking at least one named test and each file restored byte-identical (`diff` against a copy taken before). Two I can name from the record: counting a repeated ledger ref twice did nothing at first because `repeatsIn` already dedupes, so that mutation was replaced by one that bypasses `repeatsIn`, and that one fails the same-ref-twice negative control. The per-mutation list is not reproduced here because it was lost with an earlier context; treat "ten" as the count I recorded then, not a table to cite.

platform: checked that GitHub, pnpm, systemd and git have no "file a row when a class repeats" step; `row-file` is reused as the only filing path, and the failure ledger and `class-repeat` reader that already exist are extended rather than duplicated.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
