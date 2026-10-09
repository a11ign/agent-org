`src/engineer-route.ts` routes a new engineer's model and effort per row: five atomic questions through `decide` (`model-routing`), composed by the pure `composeRoute` into Haiku/high, Sonnet/medium or Sonnet/high; with no provider answering, the Region's file count and the Acceptance's shape give Sonnet/medium (at most 3 files and a command) or Sonnet/high, never Haiku. `tier:haiku` and its refusals decide before the provider is asked. `wake.ts` resolves the routes before delivery (`routesForStarts`) and `tierOfRow` reads them.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4629 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/engineer-route.test.ts'`

Mutation: `composeRoute`'s Haiku rule made never to fire failed 4 of 16, made to fire without `mechanical` failed 2; the Sonnet/medium rule made never to fire failed 2; the held-row refusal made never to fire failed 2, made always fire failed 8 (POSITIVE CONTROL: the provider-on cases); the fallback's file limit moved by one failed 2; `tierOfRow` made to ignore the resolved route failed 1. `engineer-route.ts` and `wake.ts` restored byte-identical each time (`diff` against a copy).

Measured: `VERDICT pass: 16 tests in 1 file`. The module-graph-affected set (`rstest run --changed=origin/main`): `VERDICT fail: 30 of 4104 tests failed in 220 files`, in 8 files (`board-truth-audit`, `auto-arm-token`, `milestone-clock-exact-start`, `milestone-clock`, `row-file-refuses-duplicate-title`, `row-file`, `tick-heartbeat-is-written`, `wake-engineer-brief`); each of the 8 run alone fails the same count on a clean `origin/main` checkout (2, 2, 4, 7, 1, 8, 5, 1), so none touches this change. Done-when 2 (read-only, three open rows, fake `fetch`, nothing written to the repo): see the pull request.

Closes a11ign/a11ign#4629

platform: n/a (a seam over one HTTP provider; GitHub, pnpm, systemd and git do not read a row's text)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
