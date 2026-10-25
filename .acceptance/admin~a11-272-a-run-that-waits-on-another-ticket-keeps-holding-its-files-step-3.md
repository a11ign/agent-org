Closes A11-272

Step 3 of 3. A planner that finds a step needs another ticket's work writes that ticket in a `## Blocked by` section of its plan, one `Blocked-by: <KEY>` line for each. When the board attaches the plan it records each as a blocker of the ticket in the tracker, has the ticket's blockers read again with the relation, and holds the ticket until that ticket's work has merged, so the queue orders the two tickets before any run starts. Only that section is read: a `Blocked-by:` line in prose, a fence or another section never blocks a ticket, and the ticket's own key is left out. A tracker that refuses the blocker or takes none still has the plan attached, and the log says the queue will not order the two. A plan with no such section is attached as before. The single planner's brief carries the rule (a batch's planner orders in `order.json`, as before); the worker brief says a `ticket` wait ends the turn and the board queues the run behind that ticket.

Acceptance:

```bash
# One line: a recording `tailscale` first on PATH; the section's reading (the key alone on the line, a key in the reason below it, fences, other sections, the ticket's own key), the queue transition, and the two briefs; then the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && PATH="$w/shim:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/plan-blockers.test.ts src/ticket-mode/queue/queue-plan-blockers.test.ts src/ticket-mode/worker-files.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
```

The plan attached through the board's tick is `src/ticket-mode/pool-plan-blockers.test.ts`: the tracker holds the blocker the plan named and the entry waits for it to merge; the blockers are read again and the ticket is held while the ticket it waits on starts first on the one slot; a plan with no section records none; a tracker that refuses the blocker, or has no `addBlockers`, still has the plan attached. With `pool.test.ts` (the plan attach in the same pass, unchanged) it builds a pool, which needs git history this job does not have, so CI's `suite` job runs them. Locally, with the same shim first on PATH: `AGENT_ORG_HOST=<a fixture copy's host.json> npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-plan-blockers.test.ts src/ticket-mode/pool.test.ts`.

After merge, for the chairman's session (the ticket's Done-when: no ticket `running` with a `waitingOn` ticket, none `queued` behind a parked run's files): `curl -s <the instance>/api/queue | node scripts/check-wait-state.ts` prints `the waits are clean: <n> runs, none parked on a ticket wait, no wait cycle` and exits 0 (step 2 built it; it runs before merge on a fixture of the deadlock and of the healed board in `src/ticket-mode/board-view/wait-state.test.ts`). Nothing is created or changed by it, so there is no cleanup.

Consumer-declaration: none -- no command, flag or host file key changes.
