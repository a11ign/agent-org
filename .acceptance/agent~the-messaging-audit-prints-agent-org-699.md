The messaging audit prints its count line only when it flagged something: a clean pass, and the first-run baseline, print nothing, so the repeating-line detector has no line to fire on (a11ign/agent-org#699).

Acceptance:
```bash
bash -c 'cd /home/agent/repos/wt-agent-org-699 && grep -q "a clean pass prints nothing" src/messaging/audit.test.ts && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/messaging/audit.test.ts src/messaging/audit-tick.test.ts'
```

Printed `VERDICT pass: 30 tests in 2 files` (25 in `audit.test.ts`, 5 in `audit-tick.test.ts`). The `grep` exits 1 on `main` (no test names the case) and 0 here.

Mutation (each restored from a copy, `diff` showing it byte-identical; failures counted over the two files):
- The count line never printed (`if (misuses.length > 0) print(line)` replaced by a no-op): 6 of 30 red, among them "a pass that flags one still prints", the second-pass case and the tick's stderr case.
- The count line always printed on the main pass (the pre-change behaviour): 6 of 30 red, among them "a clean pass prints nothing" and the tick's "twin" case.
- The first-run baseline printing again: 4 of 30 red, among them "the first-run baseline pass prints nothing and still writes the cursor".
- `cursor NOT WRITTEN` no longer reported: 1 of 30 red ("a clean pass that could not write its cursor is still reported"), so silencing stdout cannot hide an unfinished pass.

Judgement calls:
- **Only `flagged > 0` prints.** A clean pass that is also refused can only be refused by the cursor write (`recordFailures` returns `refused: null` on zero events), and that already reports its own reason on `report`, so the refusal is not made silent. The first-run baseline keeps its `first run, baseline at n` line on `report`: it happens once.
- **`src/messaging/audit-tick.test.ts` is outside the row's Region and is edited anyway**, declared with an `Outside-Region:` line in the body: three of its assertions (the "twin" case, the "said every tick" case and the stderr case) pinned the clean count line, so the change turns them red unless they move with it. They are rewritten to the new behaviour (the clean tick says nothing, the cursor shows it ran, a flagged tick still reaches stderr and never stdout), not deleted.
- `repeating-lines.allowlist.json` is not touched and the wording of the line is not changed, as the row says.

Neighbours: the whole suite (`pnpm test`) is `33 of 8767 tests failed in 488 files` here and `33 of 8763` with the three files at `HEAD`; the two failure lists are identical (packaging tests that need the sibling toolchain package or `gh`), so none is from this diff. `tsc --noEmit` shows only the two `mjs-ratchet.test.ts` errors, the same two as on `main`.

Measured before the change (`journalctl --user -u a11ign-work-tick --since -1h -o cat | grep -c 'messaging audit: '`, 2026-10-10 about 17:45 local): 40. Done-when 3 (that reading is 0 after one tick on the merged tool) needs the merge and a tick, so it is the gate's reading afterwards and not something this PR can print.

Closes a11ign/agent-org#699
