A stand-off whose worker replies could not be read is held, not routed. `recordRefusedRereview` returns before it records anything when the code host's reply read is unknown (`null`), so a disputed decision can no longer reach the worker by being read as "no reply"; the refused verdict stays on disk and the next sweep asks again. The test that proves it, `pool-standoff-record.test.ts` ("replies that cannot be read are not 'no reply'"), is a pool test, which needs the org's git history and runs in CI's suite; it was run red on the unfixed code and green on the fix.

Acceptance:

```bash
# One line: a recording `tailscale` first on PATH; the stand-off tests that need no git history, against the fixture project's host; the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" "$w/project" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && cp -r src/packaging/fixtures/project-tree/. "$w/project" && sed -i "s|@@PROJECT@@|$w/project|" "$w/project/.agent-org/host.json" && git -C "$w/project" init -q && git -C "$w/project" add -A && git -C "$w/project" -c user.name=f -c user.email=f@example.invalid commit -q -m fixture && PATH="$w/shim:$PATH" AGENT_ORG_HOST="$w/project/.agent-org/host.json" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/queue/queue-standoff.test.ts src/ticket-mode/standoff-dispute.test.ts src/ticket-mode/standoff-stop.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
```

Consumer-declaration: none -- no command, flag or host file key changes.
