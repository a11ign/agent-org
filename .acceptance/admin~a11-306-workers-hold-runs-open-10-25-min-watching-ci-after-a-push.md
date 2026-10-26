Closes A11-306

A ticket-mode worker ends its round at the push (A11-306): its brief, every review round's steps and the house notes say push, write the outcome, end, and do not wait on CI or on the review; the Bash hook refuses `gh pr checks … --watch`, `gh run watch` and a `sleep` over 60 seconds with a message that the board wakes the run; and the board starts the reviewer for a head with no review within 2 minutes of its required checks going green (a pass that only starts first reviews runs every minute) and logs how long after the checks were first read green it started. The board's existing wakes are what a worker no longer waits for: a required check red after the run ended starts a round (rerun first, A11-300), a green head with no review stays watched. The Stop hook is as it was.

Acceptance:

```bash
# A recording `tailscale` first on PATH; the new and changed tests against the fixture project's host; the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" "$w/project" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && cp -r src/packaging/fixtures/project-tree/. "$w/project" && sed -i "s|@@PROJECT@@|$w/project|" "$w/project/.agent-org/host.json" && git -C "$w/project" init -q && git -C "$w/project" add -A && git -C "$w/project" -c user.name=f -c user.email=f@example.invalid commit -q -m fixture && PATH="$w/shim:$PATH" AGENT_ORG_HOST="$w/project/.agent-org/host.json" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ci-wait.test.ts src/ticket-mode/pool-review-start.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/server.test.ts src/install/house-notes.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
```

Before merge, each line of the ticket's Acceptance is proven by a named test:

- A worker ends its round at the push: `worker-files.test.ts` "A11-306: the first-run brief says: push, write the outcome, end, and do not wait on CI" and "every review round ends at the push, as the last step of its steps"; the red check after the run ended starting a round: `pool-review-start.test.ts` "a required check that goes red after the run ended starts a round, and the round's brief carries the failure". The Stop hook is untouched (`hook.ts`'s stop path has no change; `hook.test.ts` passes as it was).
- No defect slips through because the worker left: `pool-review-start.test.ts` "a required check that goes red after the run ended starts a round" (pushes, ends, then fails `suite (1)`; the round's brief carries the failure) and "…already red when the run ended starts a round too"; "a green head with no review stays watched, gets its reviewer from the watch, and starts no round until the review has findings".
- The `--watch` habit is caught: `ci-wait.test.ts`, one test for `gh pr checks … --watch`, one for `gh run watch`, one for a `sleep` over 60 s, each through the Bash hook's `toolVerdict`, and the message says the board wakes the run.
- The reviewer starts within 2 minutes of the required checks going green: `pool-review-start.test.ts` "the reviewer starts within 2 minutes of the required checks going green, however the sweep falls on the green" (injected clock, the pass on `REVIEW_START_MS`), and `server.test.ts` for the cadence; the gap log: "the watch logs how long after the checks were first read green the reviewer started".

After merge, run by the board 7 days after release (the ticket's Done-when names the board as runner): in-session CI waiting is 0 in the run log and CI history, the median time a run is open per round falls by at least 15 minutes against the week before, and the share of merged pull requests later reverted or fixed by a follow-up is no higher than the week before. Nothing to clean up: it only reads.

Consumer-declaration: none -- no command, flag or host file key changes for a project: the worker brief and house notes are text, the Bash hook refuses three more commands, and the reviewer sweep runs more often.
