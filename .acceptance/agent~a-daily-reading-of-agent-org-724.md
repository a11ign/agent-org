A daily reading of engineer starts by route (`routeShares`), the first-pass merge by route for haiku/high, sonnet/medium and sonnet/high joined through the decision `id` `row-<n>`, and a guard that files ONE failure-ledger incident per lower tier more than 5 points under Sonnet/high's at n >= `MIN_RATE_ROWS`; a CLI prints both readings and tells the day's post as an announcement (a11ign/agent-org#724, #4875 item 4).

Acceptance:
```bash
bash -c 'cd /home/agent/repos/wt-agent-org-724 && npx rstest run --config scripts/rstest/rstest.config.ts src/route-guard.test.ts'
```

The row's command, `npx rstest run src/route-guard.test.ts` without `--config`, exits 1 on EVERY test file in this repo: `src/engineer-route.test.ts` fails the same way ("No test suites found in file"), because the `node:test` suites need `scripts/rstest/rstest.config.ts`. The `--config` form above is the one that runs. The test needs no `AGENT_ORG_HOST` (run here with it unset): `route-guard.ts` imports `engineer-route.ts`, `decision-provider.ts` and `haiku-tier-report.ts` only from the CLI, since each resolves the host on import.

Printed `VERDICT pass: 15 tests in 1 file`. With `src/trace/haiku-tier-report.test.ts` and `src/engineer-route.test.ts`: `VERDICT pass: 72 tests in 3 files`.

Mutation (each applied to a copy of `src/route-guard.ts`, the file restored from it and `diff` byte-identical after the run):
- The guard never fires (`over: false`): red, the 6-under case and the exact-5 case.
- The guard always fires (`over: true`): red, the 4-under case and the exact-5 case.
- `>=` for `>` on the gap: 1 red, the exact-5 case.
- The gap taken in floats rather than integers: 1 red, the exact-5 case on rates a float gets wrong.
- The merged floor `>` for `>=` `MIN_RATE_ROWS`: red, the floor case.
- No floor at all: red, the floor case and the "read failed shows no figure" case.
- The baseline's own readability not required: 1 red, the floor case (a tier compared against an unreadable Sonnet/high).
- A day in the incident's ref (a second day files a second incident): red, the 6-under case and the second-day-skip case.
- An unrecognised `via` dropped from the parts: 1 red, the parts-sum-to-starts case.
- The FIRST route line of a row kept rather than the last: 1 red.
- A non-`jev` start counted as the provider's: 1 red.

Judgement calls:
- **Only `via jev` rows are compared.** A fallback, refused or override start was not the provider's choice, so its first-pass rate says nothing about a tier's rule; they are counted apart in the starts reading and dropped from the merge reading.
- **A row is read under its LAST route line**, the one that took effect.
- **7-day window.** A lower tier rarely has 8 merged rows in a day; `--since` sets another. The incident's ref carries no day, so a breach is one line until someone clears it, even if fixed and returned; that cost is the row's "no second incident on a second day".
- **The baseline must be readable too.** A tier is not judged against a Sonnet/high that itself has under 8 merged rows.
- **"Raise `MEDIUM_MAX_P_SUBSYSTEMS`" in the row is the wrong direction**: it is a ceiling, so a breach names "lower `MEDIUM_MAX_P_SUBSYSTEMS`" (sends fewer rows to Sonnet/medium). The test pins every named constant to a name `engineer-route.ts` exports.
- **"By whatever #4748's reading uses"** is the announcement path of the decision-confidence post (kind `summary`, announcement audience, one per UTC day, messenger then chairman chat then epic #4627). That plumbing sits outside this row's Region, so it is COPIED into `route-guard.ts` with a comment; extracting it from `decision-confidence-post.ts` is a follow-up.
- **`pullOutcome` is exported from `haiku-tier-report.ts`** and `measuresOf` uses it, so "first-pass merge" has one definition for the Haiku report and the guard (72 tests above show the report unchanged).
- A first-pass read that failed (`gh` or the store) prints `NOT READ`, files nothing and exits 2, so a scheduled `--record` does not look as though the guard looked.

Done-when 2, `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node src/route-guard.ts` at 2026-10-10T19:46Z over `~/.cache/a11ign/decisions` (606 lines: 219 `jev`, 77 `fallback`, 13 `refused`, 2 `override` outcomes in the file) and the default trace store:
- Starts by route, 2026-10-03T19:46Z to 2026-10-10T19:46Z: 165 route lines on 81 rows; the provider's routes (via jev), 154: haiku/high 3 (2%), sonnet/medium 27 (18%), sonnet/high 124 (81%); not the provider's: refused 10, override 1.
- First-pass merge by route: **NOT READ**. The one `gh issue list --repo a11ign/a11ign --state closed --search closed:2026-10-10T09:00:04Z..<now> --limit 1000 --json number,labels,closedAt,closedByPullRequestsReferences` call failed three times with `GraphQL: API rate limit already exceeded for user ID 328832207`, while `gh api rate_limit` showed `graphql` 4952/5000 and `core` 4894/5000. The guard therefore did not look and filed nothing. No first-pass figure is quoted, and none is inferred. The log is a single day (the earliest routing is 2026-10-10T09:00Z), and haiku/high has 3 `jev` starts, so on a successful read it would be "not readable" below 8 merged rows in any case.

Neighbours: `tsc --noEmit` shows only the two `src/packaging/mjs-ratchet.test.ts` errors (unresolved `@a11ign/toolchain/mjs-ratchet`), in a file this diff does not touch.

Closes a11ign/agent-org#724
