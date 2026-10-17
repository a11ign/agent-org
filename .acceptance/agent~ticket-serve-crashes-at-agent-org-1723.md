`ticket:serve` starts on a host file that holds only `clones` and `tickets` (agent-org#1723). Before, `reviewer-port.ts` resolved the org's `primary` project when it was imported, so a host without one crashed at import with `ProjectDeclarationRefusal ... field primary REFUSED` and a stack. Now the gate's modules load through a top-level `await` that KEEPS their refusal instead of throwing it. A host that starts no reviewer never reads the gate. A host with `tickets.reviewer` set and no `primary` logs the named refusal once (`tickets.reviewer is set, but no reviewer starts: ...`) and starts no reviewer; the instance still runs. `readTicketSettings` reads `~/.agent-org/host.json` when `AGENT_ORG_HOST` is unset or empty, so `ticket:remote-info` gets the same fallback through the shared reader; a set variable naming an unreadable file is still refused by name.

Design choice: with `tickets.reviewer` set and no `primary`, the instance STARTS (one named log line, no reviewer) and does not exit 2. Exit 2 would need a change to `server.ts`'s startup catch, which is outside this row's region. The row allows either outcome.

Acceptance:
```bash
grep -q "ticket:serve starts on a host file with only clones and tickets" src/ticket-mode/serve-ticket-only-host.test.ts && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/serve-ticket-only-host.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/settings.test.ts
```

The row's issue text starts the command with `cd ~/repos/agent-org`, the shared main checkout, which does not carry this change. The command was run from this PR's worktree root instead, with the same grep and the same three test files.

## Evidence

Acceptance (worktree, final code):
```
VERDICT pass: 32 tests in 3 files
```
The new file `serve-ticket-only-host.test.ts` runs 5 tests: each runs the real `server.ts` in a child process with a fake `herdr` on PATH (never the real one), except the import test, which runs `reviewer-port.ts` in a child.
- ticket-only host, no reviewer: starts, no stack, no `ProjectDeclarationRefusal`.
- positive control, same entry on a host WITH `primary` (the `row-claim-file-overlap-rule` fixture, copied to a temp dir): starts.
- ticket-only host with `tickets.reviewer: "atomic"` and `drafts: false`: starts, logs `tickets.reviewer is set, but no reviewer starts: ... primary ...`, no stack.
- import of `reviewer-port.ts` with no `primary`: exits 0.
- `AGENT_ORG_HOST` unset, `HOME` pointing at a temp home with a ticket-only `.agent-org/host.json`: starts.

`settings.test.ts` adds two tests: the unset and empty `AGENT_ORG_HOST` cases read `~/.agent-org/host.json` (a temp home), and a set variable naming an unreadable path is refused by name without falling back.

Typecheck (`pnpm run typecheck`, `tsc --noEmit -p tsconfig.json`): `EXIT 0`.

Full suite (`pnpm test`, `node scripts/test-entry.ts`), final code: `VERDICT fail: 77 of 12399 tests failed`. The same suite on a detached worktree of `HEAD` (no uncommitted changes): `VERDICT fail: 77 of 12393 tests failed`. The failing test names are identical in both runs (the 20 listed in the report), so the red is pre-existing and not from this change. The six extra tests are the new ones, all passing.

CI-equivalent gates (`.github/scripts/workflow-paths.ts`, `.github/scripts/leak-scan.ts`, `node_modules/@a11ign/toolchain/dist/layout-check.mjs`): all pass (`workflow paths: 7 workflows, 16 paths named, all present`; `leak scan: 2811 files examined, 0 leaks`; `layout-check: ok`).

`package.json` has no `lint` script and no `test:org` script; the checks above are the project's own gates.

## Mutation checks

Each guard was reverted on its own, the affected files run, and the line restored:
- Settings fallback: `env[HOST_FILE_ENV] || join(home, ".agent-org", "host.json")` replaced by `env[HOST_FILE_ENV] ?? ""`. Result (`serve-ticket-only-host.test.ts` + `settings.test.ts`): `VERDICT fail: 2 of 24 tests failed`, the two failures being the env-fallback serve test and `with $AGENT_ORG_HOST unset or empty, the host file is ~/.agent-org/host.json`.
- Static gate: the top-level gate's refusal handler rethrown (`(refusal) => { throw refusal; }`), which is the old import-time crash. Result (`serve-ticket-only-host.test.ts`): 4 of 5 fail (no-reviewer start, reviewer-set start, env fallback, and the import test). The positive control (`primary` present) still passes, which shows the tests tell the two cases apart.

Both lines were restored and the acceptance files re-run green (`VERDICT pass: 32 tests in 3 files`).
