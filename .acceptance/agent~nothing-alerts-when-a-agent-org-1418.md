Nothing alerts when a repository goes unread for longer than the 15-minute sweep pacing promises. A new org-health reading, `repository-unread-past-sweep`, trips when a declared repository's last whole read (`other-scopes-memory.json`) is older than `GRAPHQL_SWEEP_MINUTES` plus one tick (15 + 2.1 = 17.1 min, strict "older than"). A trip names each repository with its age. A repository with no stamped whole read is UNKNOWN (`CANNOT_TELL`), never clear. A trip stands over an unknown. Poll hosts stamp no whole reads, so they are not asked. The threshold is computed in `src/work-gate/org-health.ts` and passed in, so `src/org-health.ts` does not import `pacing.ts` (which imports it).

Acceptance: `node --test src/packaging/gate-graphql-pacing.test.ts`, `pass 29, fail 0`. The new test covers the three done-when cases: stale 40 min trips with the repository named and its age; 17 min is clear (the red control, one minute inside the limit); 5 min is clear; a missing stamp gives UNKNOWN with the `CANNOT_TELL` text; a stamp is not unknown; a trip stands over an unstamped repository.

Mutation: each mutation was applied to `src/org-health.ts`, the test file was run, and the file was restored from a saved copy and checked with `cmp` each time.
- never fires (`if (late.length > 0)` → `< 0`): 1 test fails (28 pass).
- always fires (`now - r.readAtMs > limit` → `> -1`): 1 test fails (28 pass).

Fails before the change: not run. The test file imports `sweepOverdueReading`, which did not exist before, so the file cannot load. This is reasoning, not an observed run.

Typecheck: `pnpm run typecheck` exits 0.

Full suite: `pnpm run test` (rstest) was still running when this pull request was opened. Its result will be recorded in a follow-up commit on this branch.

Related tests: 64 test files that mention org-health or SIGNALS were run with `node --test`. 45 individual tests fail, and `src/trace/trace.test.ts` fails as a file. The same 45 fail on an unmodified HEAD checkout, so they are pre-existing and environment-related. The failing names are identical before and after this change.

Live read on this host (`readSweepFact()`, read-only): this host is a webhook host, so it asks. It returned 9 repositories and 4 stale stamps (`a11ign/documents`, `a11ign/.github`, `a11ign/lab`, `a11ign/screenreader-worker`, each last read about 17 min ago), so the reading is a real trip here. Whether those four are stale because the sweep has stopped reading them, or because they are read rarely by design, is not established by this change.

Changeset: `.changeset/a-repository-unread-past-the-sweep-is-named.md`, `patch`. Judgment call: this is a fix that a pinned project takes without changing anything. A `minor` would be a new behaviour, but it would be the breaking level while the version is 0.x.

Wiring outside the stated Region: `src/work-gate/org-health.ts` (the fact and `readSweepFact`), `src/work-gate.ts` (the io hook), `src/work-gate/reads.ts` (exports `webhookMode`), and `src/work-gate/org-health-suppression.ts` (the class is declared as PAGE).

Closes a11ign/agent-org#1418

platform: the reading is fed from the on-disk `other-scopes-memory.json` on the webhook host; no GitHub API is called by the new code.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
