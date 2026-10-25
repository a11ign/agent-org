Refs A11-279

Step 2 of 7. Runs resume by themselves after a restart, and an idle run is never shown as only running. Every ticket-mode `herdr agent prompt | read | send-keys` reaches the run's agent by its pane (`agentTarget` in `src/ticket-mode/pool-resume.ts`), never by its name, which herdr 0.9.3 refuses (`agent_not_found`). A restart (a new boot id, a new start of `agent-org-herdr.service`, or the instance's first pass) sends each running run that is idle at a prompt or interrupted, with no outcome but a `working` note, one resume prompt in that pass, and its card says "Resumed after a restart at …". A run idle at a prompt for ten minutes is resumed once ("Idle since …, resumed at …"), and ends `needs-human` with its pane kept if it is still idle ten minutes later. A run whose workspace a restart lost is queued again first, and its brief opens with "A restart lost this run's session". A run restored under a new workspace id is reached there.

Acceptance:

```bash
# One line: a recording `tailscale` first on PATH (none of these tests may reach it); the resume, idle and restart tests, and the suites whose herdr calls moved from the agent's name to its pane; then the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && PATH="$w/shim:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-resume.test.ts src/ticket-mode/pool-wait.test.ts src/ticket-mode/pool-readopt.test.ts src/ticket-mode/ci-spend/watch.test.ts src/ticket-mode/pool-answer.test.ts src/ticket-mode/wait-on/wait-prompt.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
```

`src/ticket-mode/pool.test.ts` (the start dialog, the safety-prompt decline, the background-gone prompt and the ticket-change prompt, each now asserted at the pane `w1:p1`) needs the fixture project, so CI's `suite` job runs it.

Mutation: each of these, applied alone, turns `src/ticket-mode/pool-resume.test.ts` red: the agent addressed by its name (12 tests), no restart resume (7), no idle watch (4), no card line (3), the resume and idle clock not dropped when the run ends (2) or when it is stopped and queued again (1), lost runs queued in reverse (1), an unreadable restart read overwriting the record (1), a wait's wake sent beside the resume (2), an instance's start prompting a run on its wait or its background work (1), no re-seat of a moved workspace (1), a refused prompt counted as the resume (1), working on not spending a resume (1), a woken wait idle-resumed (2), no lost-run brief line (1), a resumed run ended `no-outcome` in the same pass (1).

After merge, for the chairman's session: with live runs, `systemctl --user restart agent-org-herdr`. A pass: within one tick (30 s) `herdr --session tickets agent list` shows each of them `working`, each card says "Resumed after a restart at …", the instance log has one "was sent the resume prompt after a restart" line per run, and a terminal link on the board still opens (`tailscale serve status` lists :9443 and :9444).

Consumer-declaration: none -- no command, flag or host file key changes. The queue file gains two optional entry fields (`idleSince`, `resume`) and the state folder `tickets/restarts.json`.
