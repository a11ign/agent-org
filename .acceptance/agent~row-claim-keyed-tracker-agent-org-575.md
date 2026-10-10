A claim, a dispatch, a decline and a conflict in a declared keyed tracker (`--tracker=agent-org`) write THAT tracker and nothing of the first tracker's same-numbered row; this is the build of a11ign/a11ign#4737 (the row of record, the bare-numbered mirror of agent-org#575, with the larger scope), and it contains #575's own build.

What changes, by the mirror's five items:

1. **Labels and comments in the keyed repository, no "not built" refusal.** `trackerClaimRefusal` returns `null` for every mode once the names are right (`wt-<key>-<n>`, `worker-<key>-<n>`; an undeclared key, a `wt-<n>` worktree and a `worker-<n>` session still refuse, each for its own reason). The tracker (`{ key, repo, board }` from `trackerFor`) is threaded through `claimOrDispatch`/`runDecline` -> `claimRow`/`dispatchRow`/`declineRow` -> the reads, the label creates and PUT, the claim/release/blocked-by comments and the card move. `conflict` logs under the tracker's key, so row 575 of two trackers is two rows.
2. **The card on the tracker's own board, or labels alone.** A keyed claim's move is one `gh project item-edit <its board number> --owner <its owner>` and no board snapshot (the snapshot is bound to the first tracker's board). A tracker with no `board` declared claims with labels alone and says `no board declared for tracker <key>`; it never falls back to the first tracker's board (a case pins it).
3. **The worktree is made from the keyed repository's clone.** `claimCloneFor` takes `host.json`'s `clones.<key>` (the same `cloneOfKey` the spawner's `spawnClaimer` already launches keyed claims from); every git call of the claim runs `-C <clone>` and a relative `--worktree` is resolved from it. A keyed claim with no `clones.<key>` is refused before any write, naming the field. `worktreeTargetReason` still refuses before any write when the path or branch exists, and #2014's row-branch rule now asks the keyed origin, not the first tracker's.
4. **B4 and `blockedBy` read the keyed repository's rows and pull requests**, and a refusal names the repository (`overlaps #581 in a11ign/agent-org`, `blocked by still-open a11ign/agent-org#12`); the first tracker's refusals read as they always did.
5. **A half-way claim is undone in the same call.** A keyed claim that throws after its tree was made releases the labels it wrote (`declineRow(..., keepWorktree: true)`), removes the tree and branch it created, and the error says which of those happened or could not (`UNDONE IN THE SAME CALL: ...`). The first tracker's claim leaves them for `decline`, as before, and a case pins that as the control.

The two questions the order asked to have answered:

- **Should a claim create the labels `in-progress`/`started`, or should the vocabulary declare them?** A claim creates them. `applyClaimLabels` already runs `ensureLabelsExist` (`label create --force`) on every claim and, with the repository threaded, it runs against the tracker's repository: the first keyed claim makes `in-progress`, `session:<name>`, `started` and `was-ready` there (a case asserts the four creates, singly and batched, go to `a11ign/agent-org`). That is the only thing that works for `session:<name>`, which is per-session and cannot be declared in advance, and the lifecycle labels are deliberate literals in the leaf `claim-labels.ts`, so no vocabulary change and no change to that file.
- **Where does a keyed claim expect the clone?** At `host.json`'s `clones.<key>`, an absolute path; the declaration (`project.json`) names repositories, not paths.

Acceptance: `bash -c 'cd /home/agent/repos/wt-agent-org-575 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/row-claim-writes.test.ts src/packaging/multi-board-claim.test.ts'`

(The mirror's own line is the same command from `/home/agent/repos/agent-org`; the new cases exist only on this branch, so from the main checkout it would run the old files and pass without them. Run from this worktree it runs the new cases. `src/row-claim.test.ts`, new in this pull request, holds the wiring and clone cases with real-git fixtures and passes 23/23.)

Closes a11ign/a11ign#4737
Closes a11ign/agent-org#575

Outside-Region: src/row-claim.test.ts — #575's own Acceptance file, new in this pull request: the refusal, write, board, clone, rollback and CLI-wiring cases with real-git fixtures, which the mirror's two files cannot hold without importing real git into them.
Outside-Region: src/row-claim/blocked-by-edge-rule.ts — item 4: `blockedByEdgeReason` takes an optional `{ repo }` so a keyed row's refusal names the repository; absent, the line is byte-identical.

platform: n/a (no GitHub, pnpm, systemd or git feature is named beyond `gh issue`/`gh label`/`gh project item-edit` and `git -C <clone> fetch|worktree add|worktree remove|branch -D`, which this tool already called for the first tracker)

Evidence (this branch): the two Acceptance files pass (42 tests), `src/row-claim.test.ts` 23/23, and the other test files that import `row-claim` pass unchanged except `src/packaging/row-file.test.ts`, which fails the same 8 of 184 tests at `origin/main` in this checkout (its fixtures assume the first tracker's repository); `tsc --noEmit` reports only the two pre-existing `mjs-ratchet.test.ts` errors. Mutations each turn at least one named case red and restore green: no `-C` wrapper, the tree not resolved from the clone, no rollback, the rollback skipping the labels, a no-board tracker falling to the first board, the conflict key ignored, dispatch refused, the clone not used by the CLI, and the `blockedBy` refusal not naming the repository.

Residuals, unchanged by this row: the spare registry (`recordHeldRow`) keys by bare row number, so a spare's one-row rule cannot tell the two trackers' row 575 apart. The live `WOKE worker-agent-org-575 <- engineers/ready-row-unclaimed/agent-org#575 (STARTED ...)` quote the Done-when needs, on agent-org#515 and a11ign/a11ign#4627, is product-manager's to collect after merge.

Net lines: positive (the keyed write path, clone and rollback in `row-claim.ts`, the tests); one helper per concern (`trackerOfKey`, `claimCloneFor`, `takenBack`), and no function was added where an existing one could take a tracker.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
