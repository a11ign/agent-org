Refs A11-279

Step 4 of 7. `src/host-kernel.ts` owns the text of `/etc/sysctl.d/90-a11ign-hang.conf` (`HANG_CONF`): `kernel.softlockup_panic = 0`, with `panic_on_rcu_stall = 1`, `panic_on_oops = 1` and `panic = 10` kept and `hung_task_panic` left out, each line with its reason, and a header that records why the file exists (a11ign/a11ign#3846) and why the soft-lockup line changed (A11-279). `node src/host-kernel.ts --hang-conf` prints it. `host:check` (`kernelFindings`) raises `HANG SETTINGS DIFFER` when the file or a live `/proc/sys/kernel` value differs, `KDUMP NOT LOADED` when `/sys/kernel/kexec_crash_loaded` is not 1, and `CRASH RECORDS NOT READABLE` when this user is refused the newest pstore record, each with the root command; a refused read is `NOT READ`. The module writes nothing under `/etc`.

Acceptance:

```bash
# One line: the module's tests with a recording `tailscale` first on PATH (none of them may reach it), then the printed text must hold `softlockup_panic = 0` and no `= 1` for it; the run must pass AND the stand-in must have recorded no call.
bash -c 'w="$(mktemp -d)" && mkdir "$w/shim" && printf "#!/bin/sh\necho \"\$*\" >> \"$w/calls.log\"\n" > "$w/shim/tailscale" && chmod +x "$w/shim/tailscale" && PATH="$w/shim:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts src/host-kernel.test.ts; ran=$?; calls="$(cat "$w/calls.log" 2>/dev/null)"; rm -rf "${w:?}"; conf="$(node src/host-kernel.ts --hang-conf)"; echo "tailscale calls recorded: ${calls:-none}"; [ "$ran" -eq 0 ] && [ -z "$calls" ] && printf "%s\n" "$conf" | grep -qx "kernel.softlockup_panic = 0" && ! printf "%s\n" "$conf" | grep -Eq "^kernel.softlockup_panic *= *1" && ! printf "%s\n" "$conf" | grep -q "^kernel.hung_task_panic"'
npm run typecheck
```
