The routing provider's accuracy is measured (a11ign/agent-org#688, use 4 of a11ign/a11ign#4627): `src/route-accuracy.ts` joins each row's LATEST `model-routing` decision to the row's merged diff and reports, for `score` and `mechanical`, how often the provider's answer matched, by the confidence it gave it. `subsystems` and `debugging` are printed `NOT MEASURED`.

Acceptance:
```bash
bash -c 'cd /home/agent/repos/wt-agent-org-688 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/route-accuracy.test.ts'
bash -c 'cd /home/agent/repos/wt-agent-org-688 && env -u AGENT_ORG_HOST npx rstest run --config scripts/rstest/rstest.config.ts src/route-accuracy.test.ts'
```

The row's own command is `cd /home/agent/repos/agent-org`, the primary checkout, which carries this change only after the merge; these are the same command in this worktree, the first with the host set (18 tests: `VERDICT pass: 18 tests in 1 file`) and the second without it (`VERDICT pass: 17 tests in 1 file (1 skipped)`; the skipped one imports the real `engineer-route.ts`, which cannot be imported with no host, and says so).

What the tests pin (`src/route-accuracy.test.ts`, each with its negative control beside it):
- **Agreement per bucket**: 8 of 10 at 0.7 and over, 4 of 10 under 0.4, and an answer at exactly 0.4, 0.55 or 0.7 falls in the bucket above. Control: the two buckets' rates differ, so they are not one pool.
- **A repeated ask counts once**, by its latest decision, with `(asked 3 times)` printed. Control: the same three decisions in another time order settle on another answer.
- **An example row is excluded and counted**: `Held out, named as an example in the criteria (1): row-4748 (asked 2 times)`. Control: the same row is scored when no example names it. An example with no merge is held out, not reported as unmerged.
- **A sample under the minimum prints `n=9, not a rate`**. Control: one more decision prints `100% of 10`.
- **A decision with no merged pull request is named**: `No merged pull request found (1): row-1001 (asked 2 times)`. Control: with its merge present it is measured and nothing is named.
- **The answer scored is the one the provider GAVE** (`asked`), not the fallback that replaced it; an answer with no confidence (a 422) is the provider's no one and is counted apart.
- The two truths: the score a diff earns (nearest example, the lower level on a tie) and `mechanical` (at most 8 files and 50 changed lines), each with its boundary; the merge join (`mergesOf` over a fake `git`: `.acceptance/` and `.changeset/` less, a row's files unioned and its lines summed across merges, a `…-agent-org-688` tail not a11ign's row).

The live CLI over `~/.cache/a11ign/decisions` (181 decisions via jev on 76 rows, merges read from `origin/main` of agent-org, control, lab, toolchain, documents, screenreader-fleet, screenreader-worker, .github and a11y-witness, 2026-10-10):

```
score
  confidence      agrees with the diff      within one level
  under 0.4       18% of 22                 100% of 22
  0.4 to 0.55     n=8, not a rate           n=8, not a rate
  0.55 to 0.7     64% of 14                 100% of 14
  0.7 and over    82% of 17                 100% of 17
  the floor, 0.7:
    under 0.7     34% of 44                 95% of 44
    0.7 and over  82% of 17                 100% of 17

mechanical
  under 0.4       67% of 18
  0.4 to 0.55     n=4, not a rate
  0.55 to 0.7     n=5, not a rate
  0.7 and over    94% of 34
  the floor, 0.7:
    under 0.7     70% of 27
    0.7 and over  94% of 34
```

61 rows measured, 1 held out (row-4748), 14 with no merged pull request found (named in the output).

Mutation:
Each applied to `src/route-accuracy.ts` and run over `route-accuracy.test.ts` (baseline 18 tests green with the host set), restored from a copy, and `diff` showed it identical:
- the latest decision taken as the earliest: 1 of 18 red.
- a held-out row scored: 1 red.
- the minimum sample ignored (a rate for every bucket): 1 red.
- the fallback scored instead of the provider's `asked`: 1 red.
- an unjoined row dropped and not named: 1 red.
- decisions counted as rows: 1 red.
- the `mechanical` answer inverted: 2 red.

Typecheck: `npx tsc --noEmit -p tsconfig.json` reports no error in `src/route-accuracy.ts` or its test.

Reviewer, be sceptical of the two truths: both are CHOICES, named as constants and in the module header. `score`'s is the nearest of the criteria's own example sizes (their spans overlap on each axis alone, so a bracket on one axis names no single level), and `mechanical`'s is a size, so a short new module that was designed reads as mechanical. A row merged by more than one pull request is the union of its files and the sum of its lines, with the merge count kept in the reading.
