The stop hook's bound names the block an answer has since cleared. When the bound fires for a worker session whose earlier BLOCKED declaration on the row was answered (its `answer:<to>` label is no longer on the row), the declared reason quotes that block's first line: `second bound after an answered block (<first line>); the turn ended again with no pull request and no declaration`. `answeredBlockOf` (`src/worker-stop-hook.ts`) reads the newest `BLOCKED` comment the session left on the row that owes an answer, and returns null when the label is still there or the comment's time cannot be read; `boundReason` keeps today's text byte for byte when it is null. A ruling on the restated block is checked against the earlier block's reason, so a ruled repeat still writes the declaration and no label and no comment (agent-org#1493). Region: `src/worker-stop-hook.ts`, `src/worker-stop-hook.test.ts`.

Acceptance: `cd /home/agent/repos/wt-agent-org-1693 && node --test src/worker-stop-hook.test.ts`

Mutation (on `src/worker-stop-hook.ts` in place, copied to the scratchpad first and restored from the copy; `diff` against it printed nothing after each):
- The label check ignored (`labels.includes(...)` replaced by `false`): 1 of 15 fails, the test that quotes the first line of a longer reason and keeps today's text for a block still owed an answer.
- The ruling check inverted (`!== null` replaced by `=== null`): 3 of 15 fail, the ruled-repeat test, the negative controls for the ruling, and the POSITIVE CONTROL (agent-org#1687).
- The enrichment disabled (`answeredBlockOf(...)` replaced by `null`): 2 of 15 fail, the POSITIVE CONTROL (agent-org#1687) and the first-line test.

Measured, after the last change:
- The row's command: `ℹ tests 15`, `ℹ pass 15`, `ℹ fail 0`.
- The same file under rstest, narrow, with `AGENT_ORG_HOST` set to the fixture project's `src/packaging/fixtures/project-tree/.agent-org/host.json`: `VERDICT pass: 15 tests in 1 file`.
- `src/packaging/project-vocabulary.test.ts` (imports nothing from the hook but walks its quoted words): `VERDICT pass: 17 tests in 1 file`, run with `AGENT_ORG_HOST` set to `/home/agent/repos/a11y-witness/.agent-org/host.json`, the clone's declaration. With the fixture path it refuses (its `@@PROJECT@@` placeholder is not filled), and that refusal is a setup fault, not the change.
- `pnpm run typecheck`: exit 0.
- `pnpm run lint` is not a script in this repository. There is no `verify` script either.

Not here, and named:
- The full `pnpm test` was not run. Its entry refuses an unlaid checkout, and the narrow form above is the one its own message names.
- The host declaration. `host:install` is the host's step: the host's copy of the tool is not updated by this PR.
- Done-when 1's cause is in one comment on this row (`a11ign/agent-org#1693`), read from `worker-agent-org-1687`'s transcript for 04:28Z–04:37Z. The two later `stop-hook-bound` lines for #1687 (04:45:38Z, 04:48:12Z) are outside that window and are not read here.

Closes a11ign/agent-org#1693
