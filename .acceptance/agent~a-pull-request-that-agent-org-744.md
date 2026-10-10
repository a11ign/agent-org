A pull request that is a claimed row's deliverable cannot declare a `none` Closes line in ANY tracker, and `pr:open` says so before it sends (a11ign/agent-org#744; chairman, a11ign#4437, 2026-10-10: fifteen worker panes, none working, each holding a row whose pull request had merged).

**What changes.**
- `lookupOpenClaimedRows(repo)` reads the claimed rows of the tracker it is given; `lookupClaimedRowsOfTrackers(trackerReposFor(prRepo))` reads the tracker the pull request's repository files into and then every declared tracker. A row carries the repository it was read from and is named in full (`owner/repo#n`) in the refusal, so the remedy it prints is a line that closes the row.
- A tracker that cannot be read is named as "could not tell" and never read as "no claim"; a match in a readable tracker still refuses.
- `pr:open` runs `claimedBranchReport` for a `none` body before the Acceptance runs and before anything is sent, and refuses with the remedy (declare `Closes <row>`, file what remains as its own row). An unreadable tracker prints `UNCHECKED` and goes on; CI asks again.

**Evidence.** Both test files pass, 29 of 29. Positive control: a `none` body on a branch a claim record of the OTHER tracker names is refused by the check (exit 1, from a real process against a fake `gh`) and by `pr:open` (nothing sent, Acceptance not run). Negative control: a branch no claim names, and a pull request that finishes no row, are accepted. The neighbouring suites (`pr-open*`, `acceptance-commands`, `closes-mismatch-check` in `src/packaging`, `close-rows-*`) pass, 433 together. `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors that `main` has.

Hand mutations: four, each red in its own tests and each restore byte-identical (copy in the scratchpad and `diff`): the `pr:open` step never firing (3 red); the step refusing every `none` (1 red); only the first tracker read (3 red); an unreadable tracker dropped instead of named (4 red).

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx --test src/closes-mismatch-check.test.ts src/packaging/pr-open-closes-none.test.ts`

Closes a11ign/agent-org#744

Mutation: none -- four hand mutations of the two guards are recorded under Evidence above; there is no mutation command to run.

platform: n/a (no GitHub, pnpm, systemd or git feature beyond `gh api graphql`, which the check already used)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
