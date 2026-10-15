A reconcile's drift test no longer treats a moved repository as explained by an event that named it before the content was read. The baseline is now `factsReadAt` (per repository, stored in the held tags): an event explains a move only when it named the repository after that read (`namedSince`), and a repository no event named since then files one missed-delivery incident. The filed window starts at `factsReadAt`, not `bumpedAt`. An event still moves `bumpedAt` on every delivery, so a repository named after the read but not yet due keeps its old baseline until the reconcile that is due reads it again. The rule is `src/event-drift.ts` (`driftOf` takes `namedSince`); `src/tick-snapshot.ts` keeps `factsReadAt` and computes `namedSince = eventNamed || bumpedAt > readAt`. A held tag without `factsReadAt` (written before this change) falls back to `bumpedAt`, which is the old behaviour. Agent-org#1431, part of agent-org#982.

Acceptance:

```bash
node --test src/event-drift.test.ts src/tick-snapshot-events.test.ts
```

Mutation: the old logic restored (`namedSince = eventNamed`, window `held.bumpedAt`) failed the two new tests (the repository named after the read, and the window starting at the read); `namedSince` forced to `false` failed NEGATIVE CONTROL and the new POSITIVE CONTROL; the `factsReadAt` write removed failed 3 tests. `src/tick-snapshot.ts` was restored byte-identical each time (`diff` against a copy in the scratchpad).

Measured: `node --test src/event-drift.test.ts src/tick-snapshot-events.test.ts` → 33 pass, 0 fail. Every test file that imports `tick-snapshot.ts` or `event-drift.ts`, directly or transitively (13 files, `src/packaging/tick-snapshot.test.ts`, `work-tick-scopes-and-due.test.ts`, `work-tick-gate-budget.test.ts` among them) → 343 pass, 0 fail. `pnpm run typecheck` exits 0. The full rstest suite reports 112 failures in other files (org-health, PR-owner and ready-flip tests among them) that do not import the changed modules; this change does not alter them.

Closes a11ign/agent-org#1431

🤖 Generated with [Claude Code](https://claude.com/claude-code)
