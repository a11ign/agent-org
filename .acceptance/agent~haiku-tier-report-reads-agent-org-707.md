The Haiku trial report reads the rows CLOSED in its window instead of the 300 newest created, so a row opened before the newest 300 and closed inside the window is counted (agent-org#707).

**Premise, re-measured 2026-10-10T19:18Z.** `gh issue list --repo a11ign/a11ign --state closed --search "closed:>=2026-10-09T07:28:54Z" --limit 1000` returns 334 rows, the oldest-numbered #3215, one of the three the report lacked; 334 is past the 300 the old read stopped at.

**What changes.** `readClosedRows(from, to)` passes `--search "closed:<from>..<to>"`; `main` takes `from` from `windowStartOf(events)`, the earliest Haiku-model turn the store holds (never later than `firstHaikuStart`, so the read is a superset of the window and `reportLines` still cuts it exactly). A read that fills `CLOSED_ROWS_LIMIT` is halved and read again, and a one-second range that still fills it throws, so a window larger than the limit is whole or loud. Chosen over paging: the search selects by closing time, which `--limit` paging by creation cannot, and the upper bound keeps one `now` for the read and the report. `docs/gh-call-inventory.json` is unchanged: one `issue list` call site.

Acceptance: `cd /home/agent/repos/wt-agent-org-707 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/haiku-tier.test.ts`

Mutation (each from a copy, `diff`-identical after restore): the unfiltered `--limit 300` read restored failed 3 of 17; the halving never taken failed 1; the window start taken from any turn rather than a Haiku-model one failed 1.

Measured: `src/packaging/haiku-tier.test.ts` passes 17 of 17 (13 before, 4 new), with `src/trace/haiku-tier-report.test.ts`, `src/packaging/haiku-tier-report.test.ts` and `src/packaging/gh-call-inventory.test.ts` 34 of 34 in all. `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors `main` has.

Done-when 2, measured at this head (`node src/trace/haiku-tier-report.ts` with the host, 2026-10-10T19:18Z): the Haiku block prints `n=20 closed (17 with a merged pull request, 3 with no closing pull request, 0 unresolved)`, the 20 and 17 `gh` names for the rows closed since the window opened. The other arm was not compared against `gh`.

Closes a11ign/agent-org#707

platform: GitHub's own `closed:` search qualifier, checked live above; no new machinery.
