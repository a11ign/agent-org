Closes A11-279

Step 7 of 7. The board names what is wrong with the host. On each tick (`refreshHostAlerts` in `src/ticket-mode/host-alerts.ts`, after the serves are checked) the instance raises an alert for `/tmp` holding more than 1,000 entries, a soft lockup in this boot's kernel log (since the line's own time), a board or terminal serve that is `refused` or `foreign` in the last serve check, and hang settings that differ from the text `src/host-kernel.ts` holds (`HANG SETTINGS DIFFER`). The slow reads are made once a minute; a read that fails keeps its last answer. The queue view carries `hostAlerts` (also through the request thread's snapshot), and the Runs page draws one banner for each, with when it began in UTC and no Dismiss; an alert clears itself when its condition does.

Acceptance:

```bash
# One line: a recording `tailscale` first on PATH (none of these tests may reach it); the alerts raised and cleared over a pool with fake host reads, the kernel-log read over stand-in `journalctl`s, and the snapshot carrying the alerts to the request thread; then the run must pass AND the stand-in must have recorded no call. The pool-driven files need the fixture project (CI's `suite` job; locally `AGENT_ORG_HOST` names a fixture copy's host.json).
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && PATH="$w/shim:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/host-alerts.test.ts src/ticket-mode/board-thread.test.ts src/host-kernel.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/host-alerts.test.tsx
```

Mutation: each of these, applied alone, turns `src/ticket-mode/host-alerts.test.ts`, `board-thread.test.ts` or `ui/src/runs/host-alerts.test.tsx` red (measured, see the pull request body).

After merge, for the chairman's session: the Runs page shows no host banner on a healthy host. To see one: `seq 1 1100 | xargs -I{} mkdir /tmp/a11-279-probe-{}` and the "/tmp holds ... entries" banner appears within a minute; then `rm -r /tmp/a11-279-probe-*` and it clears within a minute. (`tailscale serve --https=9443 off` is put back by the board within 30 s, so it shows no banner unless the serve cannot be made.)

Consumer-declaration: none -- no command, flag or host file key changes. `GET /api/queue` gains an array field `hostAlerts` (`{ id, sentence, since }`), which an older page ignores. The pool's deps gain `hostAlertReads` (the instance passes the machine's).
