Closes A11-288

A plan whose `## After-merge checks` section the board refuses is sent back to its planner, up to 2 times, with the refusal and the exact format in a file beside the run's brief (`after-merge-refused-<n>.md`) and a one-line prompt to the planner's own pane. The run stays running and no card shows Needs you; the fixed plan and a new `planned` are attached as usual. The third refusal is handed to the person's session as a `working` note with one `session` wait (24 hours), which the session's queue lists and answers; it never ends as `needs-human`. A batch is sent back as a whole before any member is attached. The planner briefs (single and batch) carry the section's exact format and a worked example. A ticket line with inner double quotes or backticks matches its copy in the plan (curly quotes, an escaped quote, a doubled space); records keep the plan's own words. Any other plan refusal ends the run as before.

Acceptance:

```bash
# One line: a recording `tailscale` first on PATH; the pure format and matching tests, then the board's send-back tests against the fixture project's host; the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" "$w/project" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && cp -r src/packaging/fixtures/project-tree/. "$w/project" && sed -i "s|@@PROJECT@@|$w/project|" "$w/project/.agent-org/host.json" && git -C "$w/project" init -q && git -C "$w/project" add -A && git -C "$w/project" -c user.name=f -c user.email=f@example.invalid commit -q -m fixture && PATH="$w/shim:$PATH" AGENT_ORG_HOST="$w/project/.agent-org/host.json" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/after-merge src/ticket-mode/pool-plan-send-back.test.ts src/ticket-mode/worker-files.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
```

Before merge: the tests above pass. After merge, for the chairman's session (the ticket's Done-when: no Needs-you card cites the After-merge checks format for a week): list the board's finished runs for the 7 days after the merge and check that no `needs-human` reason names the `## After-merge checks` section. It only reads, so there is nothing to clean up.

Consumer-declaration: none -- no command, flag or host file key changes.
