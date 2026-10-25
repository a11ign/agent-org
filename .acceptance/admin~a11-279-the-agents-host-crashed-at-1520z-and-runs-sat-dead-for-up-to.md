Refs A11-279

Step 1 of 7. No test can run the real `tailscale`. Under the test runner (its run root, `A11Y_PRIVATE_TMP_RUN`, is set) `realExec`, `realExecAsync` and the service's own `runWithin` refuse `tailscale` before anything is spawned, unless the test sets `A11Y_TESTS_MAY_RUN_TAILSCALE=1` on purpose (`refuseUnderTests` in `src/plugins/real-seams.ts`). The exposure contract goes to 1.2: `unserve` is told the caller's loopback port (`ServeOptions.local`), and the Tailscale exposure removes an entry only when it proxies there, so a test or a second instance with another port leaves the host's real serves alone. Every core caller passes it (`release`, `removeServe`, `changeFunnel`). The live-default-seams guard reads `realPluginDeps`, `realExec` and `realExecAsync` as live roots and a nullish default (`deps.outgoing ?? loadOutgoing`) as a seam, with a planted positive control.

Acceptance:

```bash
# One line, as the job reads one command at a time: a recording `tailscale` first on PATH (each call it is given is appended to its log); the guard, the exposure's ownership check, the contract suite over the fake, Tailscale and local, the event tunnel's removal, and the live-default-seams guard with its positive control; then the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && PATH="$w/shim:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts src/plugins/real-seams.test.ts plugins/tailscale/ plugins/local/ src/plugins/fakes/exposure.test.ts src/event-tunnel.test.ts src/packaging/live-default-seams.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
```

The onboard and doctor tests the ticket names (`src/install/onboard.test.ts`, `src/install/onboard-demo.test.ts`, `src/install/doctor.test.ts`, `src/plugins/`, `src/ticket-mode/plugins-api.test.ts`), and `src/install/service.test.ts` (the service's own `runWithin` refusal, and `removeServe` passing `local`), need the fixture project or history, so CI's `suite` job runs them. Locally, with the same shim first on PATH: `AGENT_ORG_HOST=<a fixture copy's host.json> PATH="$work/shim:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts src/install/onboard.test.ts src/install/onboard-demo.test.ts src/install/doctor.test.ts src/plugins/ plugins/ src/ticket-mode/plugins-api.test.ts`, then `test ! -s "$work/tailscale-calls.log"`. On the agents host, `tailscale serve status` still lists :9443 and :9444 afterwards.

After merge: none for this step. Step 2 carries the ticket's After-merge check (`systemctl --user restart agent-org-herdr` with live runs).

Consumer-declaration: none -- the exposure contract's minor goes up (1.2, `ServeOptions.local`), and core, its only caller, names `local` on every `unserve`; no command, flag or host file key changes.
