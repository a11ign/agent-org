At the bound (two refusals in a row for one claimed row, no pull request, no declaration) the `worker:stop-hook` now makes the `blocked` declaration the refusal names, on the worker's behalf, through `worker:state blocked`'s own path: the row gets `answer:product-manager` and the reason, and the gate reads it. Before, the bound only wrote a `stop-hook-bound` ledger line and routed nothing (a11ign#5478, agent-org#1488).

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/worker-stop-hook.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
```

Printed: `VERDICT pass: 11 tests in 1 file` (baseline before the change: 9 tests, all green; the two new cases were red on the unchanged hook, `VERDICT fail: 2 of 11 tests failed in 1 file`, the BOUNDED case and the unreadable/closed case). `tsc --noEmit` exits 0. `src/worker-state.test.ts` (the pinned gh call count is there) prints `VERDICT pass: 36 tests in 1 file`. `src/worker-state.ts` is not in the diff.

Mutation: the declaring step deleted (`const declared = declareAtBound(session, claim, seams);` replaced by `const declared: string | null = null;` in `src/worker-stop-hook.ts`, from a copy in the scratchpad). Run: `VERDICT fail: 2 of 11 tests failed in 1 file`, the BOUNDED case red (no declaration on disk, no label, no comment) and the unreadable/closed case red (no `NOT DECLARED` in the say). Restored with `cp` from the copy and `diff`ed byte-identical; the tests then pass 11 of 11. The open-pull-request case passes both with and without the change, as the guard it is meant to be; it was not separately mutated.

Done-when 1 is the case set above: at the third refusal the row is declared blocked for product-manager (declaration written, label `answer:product-manager` put on the row, one reason comment), and the `stop-hook-bound` ledger line is still written; a row that cannot be read or is closed gets no declaration, the stop is still allowed, and the say names it `NOT DECLARED`; an open pull request at the same count writes no declaration.

## Judgement calls

- **The declaration goes through `resolveBlockedRow` first**, so a closed, unreadable, ambiguous or unknown row is refused and nothing is labelled. A declaration the row cannot take is said on stderr and the stop is still allowed; the hook never throws here.
- **`applyBlocked` is reused, and no gh call site is added to `worker-state.ts`.** The hook passes its own `gh` runner (the same `execFileSync("gh", ...)` shape as the `pr list` read, 20 second timeout) through `Seams`, and the label and comment writer is `githubTicketAdapter` scoped to the row's repository.
- **The declaration is written last**, after the label and the comment, so a declaration the row does not carry is never on disk.
- **The declaration's `at` is the hook's `now`**, and `to` is `DEFAULT_ANSWERER` (`product-manager`); the reason is the row's words, with `MAX_REFUSALS` in it.
- **The two prefixes come from `project-vocabulary.ts` through the dynamic import in `liveSeams`**, so the pure half of the hook still does not load the project.
- **Not changed, and worth a look**: the count is not reset at the bound (pre-existing). After the bound the count stays at `MAX_REFUSALS`, so a later stop that is not satisfied enters the bound branch again: a second `stop-hook-bound` ledger line and a second reason comment. A declaration made at the bound allows the stop before the count is read, so this recurs only after a new delivery to the session. Not fixed here: it is outside the row's two-refusal and ledger contract.
- **Known limit, unchanged**: the pull request is looked for in the row's own repository; a row whose work goes to another repository is refused up to the bound, then allowed, and the declaration is the way out. Said in the file's header.

platform: Claude Code's own `Stop` hook (exit 2, stderr) is the mechanism; the declaration is `worker:state blocked`'s own path through the `gh` CLI. No other platform feature is used.

Closes a11ign/agent-org#1488
