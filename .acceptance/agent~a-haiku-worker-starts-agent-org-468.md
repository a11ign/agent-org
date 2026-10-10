`HAIKU_EFFORT` in `src/worker-profile.ts` is now READ from the ordinary worker profile (`profileFor("ready-row-unclaimed").effort`, `high` today, the Sonnet workers' own) and no longer typed a second time; its comment says the value is the Sonnet workers' on purpose so the #4382 trial changes the model and nothing else, and that a `medium` arm is a later, separate step. Nothing else in the tier changed: the model (`claude-haiku-5-5`), the autocompact window and the switch are untouched, and a row without the label is byte-for-byte the ordinary launch.

State found: `HAIKU_EFFORT = CLAUDE_EFFORTS[0]` had already been replaced by the literal `"high"` on `main` (#504, a11ign/a11ign#4522, merged 2026-10-09). That fixed the value but kept it a second typed copy, which is what this row's change 1 removes; the test asserted the literal `"high"` and nothing tied it to the ordinary profile.

`src/packaging/haiku-tier.test.ts`: the Haiku launch's `--effort` equals `profileFor("ready-row-unclaimed").effort` and is `high`, with a negative control that it is not `low`; a new test asserts a Haiku launch and an ordinary launch for the same cause carry the SAME `--effort` (and that it equals `DECLARED_CLAUDE_MODELS.sonnet.effortLevel`), so a future change to one moves the other or fails.

Evidence (measured in this worktree at agent-org `0d06beb` plus this change, rstest, `AGENT_ORG_HOST` set to a11ign's `.agent-org/host.json`): `src/packaging/haiku-tier.test.ts` passes 11 tests. Mutation: `HAIKU_EFFORT` set back to `CLAUDE_EFFORTS[0]` (the old value, `low`) broke 2 tests (the launch's `--effort` assertions and the new same-effort test); restored byte-identical (`diff` clean). `tsc` reports only the `mjs-ratchet.test.ts` errors the missing `@a11ign/toolchain` link causes, none in the touched files.

Not done here: Done-when 2 (the next `tier:haiku` worker's launch line showing `--effort high`) needs the merge and the host install; it is recorded on the row when one starts.

Acceptance: `cd /home/agent/repos/wt-agent-org-468 && AGENT_ORG_HOST=/home/agent/repos/wt-4743/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/haiku-tier.test.ts`

Mutation: `HAIKU_EFFORT` made `CLAUDE_EFFORTS[0]` (the assumed `low` floor): the `--effort` equals-ordinary and same-value tests failed; restored byte-identical.

Measured: 11 tests in 1 file pass at agent-org `0d06beb` plus this change.

Closes a11ign/agent-org#468

platform: n/a (a constant read from the profile that already holds the value)
