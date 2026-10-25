Refs A11-279

Step 5 of 7. Every ticket-mode run starts with a private `TMPDIR`, `<base>/run-t-<run id>` (`src/ticket-mode/run-isolation.ts`), built by `runEnvOf` with the ticket's variables, so a run started again after a restart gets the same one. The board makes the directory when it starts the run and removes it on a tick once the run neither is live nor holds a workspace (a parked run keeps it: its agent is still open), one entry per call, at most 500 entries a pass, and not a directory modified in the last 10 minutes. A directory that cannot be made starts the run on the shared `/tmp`, said in the log. A pane that has the ticket's variables and no `TMPDIR` (a run started before this change) is not started again.

Acceptance:

```bash
# One line: a recording `tailscale` first on PATH (none of these tests may reach it); the run-environment and private-directory tests (with the pool-driven cases); then the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && PATH="$w/shim:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/run-env.test.ts src/ticket-mode/run-isolation.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ]'
npm run typecheck
```

The run-isolation tests drive the pool (they import it, which needs git history this job does not have), so CI's `suite` job runs them; locally they need `AGENT_ORG_HOST` naming a fixture copy's host.json.

Mutation: each of these, applied alone, turns `src/ticket-mode/run-isolation.test.ts` or `run-env.test.ts` red (measured): `runEnvOf` without `TMPDIR` (5 tests); `start()` not making the directory (4); a directory that cannot be made failing the start (1); `lostKeys` counting `TMPDIR` (2); the sweep not run on the tick (1); the sweep removing a parked run's directory (2); no grace (1); no budget (1); the sweep a no-op (4).

After merge, for the chairman's session: start a run (or let the next one start) and read `tr '\0' '\n' < /proc/<claude pid>/environ | grep ^TMPDIR` in its pane: it names `~/.cache/a11ign/tmp/run-t-<KEY>`; once the run is finished and closed, the directory is gone within a few ticks and `ls /tmp | wc -l` has stopped growing from workers' tests.

Consumer-declaration: none -- no command, flag or host file key changes. The instance passes `privateTmpBase` to its pool; the base is the one `private-tmp.ts` already names.
