The daily retrospective counts the open `ready` rows of every declared tracker that carry neither `tier:haiku` nor a `Tier: sonnet -- <reason>` line, and prints the count with the first ten row names. This is a11ign/agent-org#466 (epic a11ign/a11ign#4437, move 4). The gate's order to `product-manager` and the `NUMBERS` trend are NOT in this change: the first needs a cause declaration in `cause-declaration.ts` and the second a bound for the id in a11ign's `ceo.md`, both outside the row's Region (filed separately).

Closes a11ign/agent-org#466

Class: direction-not-executed — a chairman direction with a countable end state ("every mechanical row with a machine-checkable Acceptance is `tier:haiku`") that nothing counts, so it can run unexecuted for any such direction; guard: `untieredReadyRows` in the daily retrospective, which prints the count and the first ten rows, and `unknown` (never 0) when a tracker cannot be read.

Acceptance:
```bash
AGENT_ORG_HOST=/home/agent/repos/wt-4804/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/untiered-ready-rows.test.ts
AGENT_ORG_HOST=/home/agent/repos/wt-4804/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/org-retro.test.ts
```

Mutation: `hasTierDecision` made never true -> 4 of 16 red (the label, body-line, comment-line and fence-closed cases); made always true -> 8 of 16 red; the reason pattern loosened to accept an empty reason -> 1 red (the empty-reason case); `isExcluded` rows pushed into the count -> 1 red; a refused tracker's refusal not recorded -> 4 red (the `unknown` cases); the `hold:` prefix dropped from `isExcluded` -> 1 red. Each restored from a copy taken before and `diff`ed byte-identical.
