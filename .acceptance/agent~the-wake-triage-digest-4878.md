Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/triage-route.test.ts src/triage-provider.test.ts`

The row's own command is `cd /home/agent/repos/agent-org && …`: that checkout is the tool's own, detached at the newest release tag, so the command is run in the PR's tree here.

**What the test shows (a11ign/a11ign#4878):**
- POSITIVE: an order whose five answers are all at the floor and `informational-only` is yes routes to `digest` (`all five questions at the floor and informational-only yes digests…`).
- NEGATIVE, the floor unchanged: the same order with ONE answer one hundredth under the floor routes to `wake`, question by question; `repeat` is the one whose fallback is the answer it gave, and the test says so.
- NO DROP: held orders are still delivered or flushed (`the held digest rides the next order…`, `a held order is flushed alone once its oldest item is 60 minutes old`, `after a revert to provider none an order held earlier still rides and flushes`, unchanged and green).
- THE CAUSE: a tick that read a red main wakes the order that names it and asks the provider about the other three (`a red main in the tick wakes the order that names it and not the others…`).

Mutation: five, each red and each restore byte-identical (`cp` to the scratchpad, `cmp` after): `mainRed` handed to every order again (2 red: the incident); `mainRed` never handed (2 red); `readings` not written to the ledger line (1); an example count the sheet does not hold, `13 of 14` for `12 of 14` (1); the floor never binding, in `decision-provider.ts` (7 red: the floor tests of both files).

Mutation: n/a for the criteria wording itself: it is measured against the live provider, not asserted (see the changeset for the counts and what they do not show).

Closes: none -- Done-when 3 of #4878 is the digest share of the day AFTER the tag reaches the host, quoted on a11ign#4627, which this change cannot read; the row stays open for it.

platform: n/a (no GitHub, pnpm, systemd or git feature: this is the route's own state and the provider's questions)
