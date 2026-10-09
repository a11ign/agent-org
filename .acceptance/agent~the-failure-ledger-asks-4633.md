`matchFailureClass` (`src/class-match.ts`, called by `classifyIncident` in `class-repeat.ts`) asks which known failure class an incident is, as a `choice` through `decide` (use `failure-class-match`): the provider sees the incident's kind, title and first cause line and each class's id, name and guard; with no provider, no key, the use off, a refusal, a timeout or a confidence under the floor the answer is an exact match of `kind` on a class's id or declared `kinds`, else `none-of-these` and no label.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4633 && AGENT_ORG_HOST=/home/agent/repos/wt-4633/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/class-match.test.ts'`

Mutation: the kind rule dropped from the fallback failed 6 of 20; the kind match made a substring match failed 1; the 12-class limit `>` made `>=` failed 1; the two-step path made to always fire failed 8; a label named for none-of-these failed 3; the whole cause sent instead of its first line failed 2; a class named none-of-these offered failed 1; declared `kinds` ignored failed 1. Each restored from a copy and `diff`ed byte-identical. The floor itself belongs to `decide` (pinned by `decision-provider.test.ts`), and here a confidence of floor-0.01 takes the rule while exactly the floor stands.

Measured: `VERDICT pass: 20 tests in 1 file`; with `class-repeat.test.ts`, `decision-provider.test.ts`, `triage-provider.test.ts` and `src/org-health*`, `VERDICT pass: 98 tests in 6 files`. The full suite was not run. `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors that origin/main reports (the shared `node_modules` holds a toolchain without `@a11ign/toolchain/mjs-ratchet`). The tests need `AGENT_ORG_HOST` set, as `class-repeat.test.ts` does, because `class-repeat.ts` resolves `HOME_CHECKOUT` at import.

Replay of the 2026-10-09 copy-drift rows (done-when 2), in the last test: with the kind rule only, none of #4370, #4371, #4515, #4557, #4569, #4582 is placed (their kind is `defect`, a class's id is never `defect`); with a fake provider answer of `copy-drift` for titles about copies, all six get `class:copy-drift` and #4607 (a stuck red PR) gets none-of-these. The index today holds no `copy-drift` class, so the test carries it as a fixture; the real entry is a row for whoever owns the index. The fake answer shows the answer reaches the label, not that a real model would give it.

Closes a11ign/a11ign#4633

platform: n/a (a seam over one HTTP provider; GitHub, pnpm, systemd and git do not classify an incident by its text)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
