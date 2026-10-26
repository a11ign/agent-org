Closes A11-304

A transient error writing a run's result to the tracker (`fetch failed`, `ECONNRESET`, `ETIMEDOUT`, a 5xx, a 429) no longer sends a finished run to Needs you. `completeDone` (the board's completion of a worker's `done`) and `proposeEdit` (the read that records a proposed edit with the ticket's text) keep the run running with the card note "recording the result in the tracker (retrying)" and try the write again on later ticks, after 5 s, 30 s, 2 min, 5 min and then every 10 min. The worker's outcome is never rewritten: the run log still ends `finished: done`, and each failed write is an event of its own (`tracker-write`: `retrying`, `refused` or `gave-up`, with the error). Only a request the tracker refuses (a 4xx that is not 429, a missing completed state, any other thrown error), or a transient error that has lasted an hour, ends the run Needs you, under the `access` escalation item, with the tracker's own words.

Acceptance:

```bash
# A recording `tailscale` first on PATH; the new tests and the plan-attach retry tests against the fixture project's host; the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" "$w/project" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && cp -r src/packaging/fixtures/project-tree/. "$w/project" && sed -i "s|@@PROJECT@@|$w/project|" "$w/project/.agent-org/host.json" && git -C "$w/project" init -q && git -C "$w/project" add -A && git -C "$w/project" -c user.name=f -c user.email=f@example.invalid commit -q -m fixture && PATH="$w/shim:$PATH" AGENT_ORG_HOST="$w/project/.agent-org/host.json" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-write-retry.test.ts src/ticket-mode/pool-attach-retry.test.ts src/ticket-mode/attach-retry.test.ts src/ticket-mode/run-log.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
```

Before merge: the tests above pass (`pool-write-retry.test.ts` makes the first two completion writes fail and the third succeed, and covers a 4xx, a missing state and an hour of failures).

After merge, run by the chairman's session (the ticket's Done-when names the board as runner, but none of the board's `Observe:` forms reads a run-log reason, so the check is the session's, read-only, with nothing to clean up). 7 days after the release, from the chairman's session, with `BOARD` the board's base URL and `KEY` its key:

```text
for k in $(curl -s -H "Authorization: Bearer $KEY" "$BOARD/api/queue" | jq -r '.entries[].ticket.key'); do curl -s -H "Authorization: Bearer $KEY" "$BOARD/api/queue/$k" | jq -r --arg k "$k" '.runLog[]? | select(.kind=="needs-you") | select(.reason | test("could not be completed \\((fetch failed|.*(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up))")) | "\($k): \(.reason)"'; done
```

A pass is no output: no `needs-you` event in any ticket's run log whose reason contains "could not be completed (fetch failed" or another transient network error. A line printed names the ticket and its reason, and fails the check.

Consumer-declaration: none -- no command, flag or host file key changes for a project: the board's retry of its own tracker write is internal, and the run log gains one event kind the board page words.
