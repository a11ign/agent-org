A filed stuck-cause row (`answer:ceo` + `parked` + `out-of-release`) is filed once more an hour after it was closed as answered, when its cause is still emitted, as a label row is asked again (a11ign/agent-org#656). The once-rule's memory is the closed rows of the title, read back, so the ledger is not touched.

Acceptance:
```bash
cd /home/agent/repos/wt-agent-org-656 && npx rstest run --config scripts/rstest/rstest.config.* src/stuck-row-reask-filed.test.ts
```

Run in this branch's tree with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json`. Printed: `VERDICT pass: 8 tests in 1 file`. The named cases: `a filed row closed an hour ago whose cause is still emitted is filed once more`, `a row closed less than an hour ago is not filed again`, `a second closed row of the title is not followed by a third`.

Against `HEAD`'s unmodified `src/wake.ts` (swapped in from `git show`, restored from a copy and diffed identical afterwards) the same file prints `VERDICT fail: 4 of 8 tests failed`, the first case among them.

Mutation (each restored from a copy):
- the due check replaced by `return null`, so it never files: 3 of 8 red (the first case and the controls of the second and third).
- the "exactly one, and closed" and due checks removed, so it files whatever it finds: 3 of 8 red (the not-yet-an-hour, second-closed-row and open-row cases).

Typecheck: `pnpm run typecheck` reports no error in `src/wake.ts` or `src/stuck-row-reask-filed.test.ts`; its only errors are two in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable in this tree), untouched here.

Measured cost, from the code: one `gh issue list --state all --search` per tick per filed-row key that is still emitted and already escalated, the same order as the label row's per-tick event read. Not measured against a live rate pool.

Assumption: a closed row counts as "asked" whatever closed it (the tick's answered-close or a person), and an open row of the title in any state suppresses the re-ask, so a row moved on to `ready` is not doubled. Not changed: the `ALREADY ESCALATED` log wording.
