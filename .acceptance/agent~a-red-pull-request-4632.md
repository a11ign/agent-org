`classifyCiFailure` (`src/ci-failure-class.ts`) classifies a red check as own defect, flaky, another repository changed or infrastructure, names the route, and takes the deterministic rule when the provider is absent, keyless, switched off, refusing, timed out, malformed or under the floor. The test pins each case with a negative control.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4632 && AGENT_ORG_HOST=/home/agent/repos/wt-4632/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/ci-failure-class.test.ts'`

Mutation: the infrastructure rule made never to fire failed 3 of 13, always fire 4; the red-on-main rule never 3, always 2; the flaky-rerun-once guard never 2, always 2; the 40-line cap removed failed 1 (a case added after the first mutation run showed the byte budget masked it). `ci-failure-class.ts` restored byte-identical each time (`diff` against a copy).

Measured: `VERDICT pass: 13 tests in 1 file` at agent-org `9102ef3` plus this change; `tsc --noEmit` reports nothing in `ci-failure-class`. Done-when 2: the only open red PR is a11ign/a11ign#4626 (`acceptance / run`, `gate`; main green); the module read-only, no provider declared, printed `CI failure class: own-defect -> owner (rule: no triage provider is declared)`.

Closes a11ign/a11ign#4632

platform: n/a (a classifier over the existing decision seam; GitHub, pnpm, systemd and git do none of it)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
