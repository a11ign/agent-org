`ticket:serve` starts on a host file that holds only `clones` and `tickets` (agent-org#1723). Before, `reviewer-port.ts` resolved the org's `primary` project when it was imported, so a host without one crashed at import with `ProjectDeclarationRefusal ... field primary REFUSED` and a stack. Now `reviewer-port.ts` loads nothing at import. The gate's modules (`wake.ts`, `review-trust.ts`, `project-config.ts`, `project-identity.ts`, `work-gate/pr-orders.ts`) load in `loadReviewerGate()`, which `serve()` calls only when `startsReviewers(settings)` holds (`tickets.reviewer` set and `drafts` off), before the pool is made. The load keeps its refusal rather than throwing it, and `reviewerRefusal()` says it. A host that starts no reviewer never loads the gate. A host with `tickets.reviewer` set and no `primary` logs the named refusal once (`tickets.reviewer is set, but no reviewer starts: ...`) and starts no reviewer; the instance still runs. `readTicketSettings` reads `~/.agent-org/host.json` when `AGENT_ORG_HOST` is unset or empty, so `ticket:remote-info` gets the same fallback through the shared reader; a set variable naming an unreadable file is still refused by name.

Why not a static or top-level-await import: `wake.ts` and `work-gate/pr-orders.ts` have a top-level `await`, so `require()` cannot load them, and a static import in `reviewer-port.ts` loads them (and runs the `primary` check) whenever the module is imported. The lazy load avoids both.

Design choice: with `tickets.reviewer` set and no `primary`, the instance STARTS (one named log line, no reviewer) and does not exit 2. Exit 2 would need a change to `server.ts`'s startup catch, which is outside this row's region. The row allows either outcome.

Acceptance:
```bash
grep -q "ticket:serve starts on a host file with only clones and tickets" src/ticket-mode/serve-ticket-only-host.test.ts && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/serve-ticket-only-host.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/settings.test.ts
```

The row's issue text starts the command with `cd ~/repos/agent-org`, the shared main checkout, which does not carry this change. The command was run from this PR's worktree root instead, with the same grep and the same three test files.

## Evidence

Acceptance (worktree, final code): the same three files plus `pool.test.ts`, run in one invocation:
```
VERDICT pass: 130 tests in 4 files
```
`serve-ticket-only-host.test.ts` runs 9 tests. Each runs the real `server.ts` in a child process with a fake `herdr` on PATH (never the real one), except the import tests, which run `reviewer-port.ts` in a child:
- ticket-only host, no reviewer: starts, no stack, no `ProjectDeclarationRefusal`.
- positive control, same entry on a host WITH `primary` (the `row-claim-file-overlap-rule` fixture, copied to a temp dir): starts.
- ticket-only host with `tickets.reviewer: "atomic"` and `drafts: false`: starts, logs `tickets.reviewer is set, but no reviewer starts: ... primary ...`, no stack.
- `loadReviewerGate()` on a host with no `primary`: resolves, and `reviewerRefusal()` names `primary`.
- load timing (a preload module with `registerHooks` records each gate module the process resolves):
  - importing `reviewer-port.ts` on a host with `primary` loads no gate module;
  - `loadReviewerGate()` loads all five gate modules;
  - `ticket:serve` with no `tickets.reviewer` loads no gate module;
  - `ticket:serve` with `tickets.reviewer: "atomic"` and `drafts: false` loads all five before it starts.
- `AGENT_ORG_HOST` unset, `HOME` pointing at a temp home with a ticket-only `.agent-org/host.json`: starts.

`settings.test.ts` adds two tests: the unset and empty `AGENT_ORG_HOST` cases read `~/.agent-org/host.json` (a temp home), and a set variable naming an unreadable path is refused by name without falling back.

`server.test.ts` and `ui-server.test.ts` (which import the changed modules): `VERDICT pass: 34 tests in 2 files`.

Typecheck (`pnpm run typecheck`, `tsc --noEmit -p tsconfig.json`): `EXIT 0`.

CI-equivalent gates: `workflow paths: 7 workflows, 16 paths named, all present`; `leak scan: 2813 files examined, 0 leaks`; `layout-check: ok`.

Full suite: not re-run for this change. The last full-suite run (`pnpm test`, `node scripts/test-entry.ts`) was on the earlier commit, `VERDICT fail: 77 of 12399 tests failed`, and the same 77 fail on a detached worktree of `HEAD` before this work, so the red is pre-existing. The change since then touches only `src/ticket-mode/`, and the four files above plus `server.test.ts` and `ui-server.test.ts` cover those modules.

`package.json` has no `lint` script and no `test:org` script; the checks above are the project's own gates.

## Mutation checks

Each guard was reverted on its own, the affected files run, and the line restored:
- Settings fallback: `env[HOST_FILE_ENV] || join(home, ".agent-org", "host.json")` replaced by `env[HOST_FILE_ENV] ?? ""`. Result (`serve-ticket-only-host.test.ts` + `settings.test.ts`): `VERDICT fail: 2 of 24 tests failed`, the two failures being the env-fallback serve test and `with $AGENT_ORG_HOST unset or empty, the host file is ~/.agent-org/host.json`. (Recorded on the earlier commit; the settings code has not changed since.)
- Static gate import (the lazy load replaced by `import "../wake.ts";` at the top of `reviewer-port.ts`): `serve-ticket-only-host.test.ts` `VERDICT fail: 6 of 9 tests failed`. Failing: the no-reviewer start, the reviewer-set start, the no-`primary` `loadReviewerGate` test, the env-fallback serve test, and both load-timing tests that assert no gate module loads (`importing reviewer-port.ts loads none ...` and `ticket:serve ... with no tickets.reviewer loads none ...`). The positive control (`primary` present, `ticket:serve` starts) still passes, and so does the load test that expects the gate to load, which shows the tests tell the two cases apart. The mutation line was removed and the file re-run green.

Both mutations were reverted, and the four-file acceptance run was re-run green after the revert (`VERDICT pass: 130 tests in 4 files`).
