## What it is

On 2026-10-17 the host's installed `gh` wrapper (`~/.local/bin/gh`) was overwritten at 19:39Z by a rendering whose App role table was empty, so no GitHub App token was minted for any role until the chairman's session re-rendered it at 20:59Z. Two verdicts on agent-org#1738 failed to post (A11-83), and workers lost their App identity. The writer was not recorded. The tests reproduce it: with a host declaration that names no App, `host:check --json` (the tick's own re-render) overwrites a wrapper that names four roles.

## Change

- **One writer for the wrapper.** `writeGhWrapper` (`src/host-units.ts`) is the only path that puts `gh` on the host. It refuses, writes nothing and says why, when the text it would write names no App while `host.json` declares one, when it would drop the Apps an installed copy names (unless `host:install --allow-no-apps` says so), when its minter runs from `/tmp`, and, under a test run, when the target is in the real home's bin directory.
- **A test may not write the real bin directory.** The tripwire is in the writer and is switched on by the rstest config (`AGENT_ORG_UNDER_TEST`). `src/packaging/tests-never-write-the-real-bin-dir.test.ts` reads the test source and fails on a call to an identity writer, or a spawn of `host-units.ts`, that takes the machine's directories and not a fixture's.
- **The detector and the start-up.** `doctor` has a `gh wrapper` check and an `app token <role>` check for each declared role, each failure naming its fix. The instance's start-up checks the wrapper before the pool is made, in a child process so the instance does not load the gate's modules: a divergence is an `ERROR` line and a re-render, a missing wrapper is reported and not created (as the tick never created one), a refused re-render is logged and the instance starts anyway, and a failed mint is logged on every start.
- **Workers cannot write the host's programs.** The pool writes `protected-paths.json` (the `gh` and `agent-org` in `binDir`) beside each run's outcome file, and the PreToolUse hook refuses a Write, Edit or MultiEdit to them, a shell command that writes them, and `host:install`, `host:check --install` and `host-units.ts --install`.
- **Verdict posting** is A11-83's, which this branch is stacked on.

## Verified

- `src/packaging/gh-wrapper-guard.test.ts`: each refusal with a stub write that must not be called (an empty table against a declaring host; the incident replay, four roles against none, bytes unchanged; the tick's downgrade as a note; the `/tmp` minter; the tripwire with `$HOME` moved). Each has a positive or a control case. The mint probe takes the run it is given, names the minter's first line, and fails a stdout with two words. The start-up re-renders a divergence, logs a refused one and a failed mint, and does not create a missing wrapper.
- `src/packaging/tests-never-write-the-real-bin-dir.test.ts`: the walk over every test file passes; a bare writer call and a spawn of `host-units.ts` with no `AGENT_ORG_HOST` are flagged in the positive control; a fixture call and a commented call are not.
- `src/install/doctor.test.ts`: a matching wrapper passes; an empty table fails with the fix; a role whose mint fails names its reason; a wrapper that cannot be checked is not a pass.
- `src/ticket-mode/hook.test.ts`: each protected write is refused (Write, Edit, MultiEdit, `cp` to the wrapper, `cat >`, `echo >>`, `mv`, `sed -i`, `rm`, `chmod`, `dd of=`, `host:install`, `host:check --install`); a read of the wrapper (`cat`, `grep`, `ls`, `cp` from it to `/tmp`), `gh-real`, `herdr`, `host:check --json`, and a `grep` that names `host:install` or `hostUnitsInstall` are allowed; a write through a symbolic link into the bin directory is refused; the pool's copy is read end to end. Known limits, not claimed: a write by `python3 -c` or from a `cd` into the bin directory is not caught by the pattern guard, which is why `writeGhWrapper` is the real protection.
- `src/ticket-mode/server.test.ts`: a diverged wrapper is logged and re-rendered; a refused one is logged and the start-up does not throw; a check that cannot run is an `ERROR`.
- `src/ticket-mode/pool.test.ts` and `settings.test.ts`: the pool writes `protected-paths.json` beside the run; `binDir` is read from `host.json` and defaults to `~/.local/bin`.
- `src/app-role-silent.test.ts`: the switch to `user-accounts` is refused by the tick and taken by `host:install --allow-no-apps`, and back.

Refs A11-84

Flag: none. The downgrade guard is the behaviour change: a host that switches an App role off is refused by the tick until `host:install --allow-no-apps` is run.
Revert: revert this PR; `rerenderGhWrapper` writes the rendered wrapper as it did, the tick stops refusing, and the hook stops protecting the bin directory.

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-84/agent-org && npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/gh-wrapper-guard.test.ts src/packaging/tests-never-write-the-real-bin-dir.test.ts src/install/doctor.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/server.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/pool.test.ts src/app-role-silent.test.ts src/packaging/host-units.test.ts src/packaging/host-install-agent-org-launcher.test.ts'`
