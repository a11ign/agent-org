## What it is

On macOS, registering a service (`agent-org onboard`, `agent-org start <service>`, update's restarts) no longer fails when the service's label is already loaded in `gui/<uid>`. `src/install/service.ts` has one routine, `loadLaunchd`, for every place that loads or restarts a launchd agent:

- label not loaded: `launchctl bootstrap gui/<uid> <plist>`, as before;
- loaded and the plist on disk was already the new text: `launchctl kickstart -k <target>`;
- loaded and the plist changed (a missing file counts as changed): `launchctl bootout`, then `launchctl print` until the label is gone (at most 25 s, 250 ms apart), then `bootstrap`. A bootout that answers 3 or 113 (label already gone) is not a failure.
- herdr is unchanged: loaded, it is kickstarted without `-k` whatever its plist; a start never restarts it.

`restartService` (update's restart of `instance` and `ui`) kickstarts a loaded service with `-k`, bootstraps a registered one that is not loaded, and refuses one that was never registered with "`agent-org start <name>` registers and starts it". `reloadService` (the terminal) reads the old plist, writes the new one, then uses the routine.

A launchctl failure is one sentence: `the <name> service (<label>) did not load: launchctl <command> failed: <launchctl's error>. To fix it by hand, run: launchctl bootout gui/<uid>/<label>; launchctl bootstrap gui/<uid> <plist>` (enable and disable failures name `launchctl enable|disable <target>` instead). launchctl's own "Try re-running the command as root" line is dropped.

## Acceptance

Acceptance:
```bash
bash -c 'set -euo pipefail
npx rstest run --config scripts/rstest/rstest.config.ts src/install/service-launchd.test.ts src/install/service.test.ts src/install/herdr-service.test.ts
npm run typecheck
npx eslint src/install/service.ts src/install/service-launchd.test.ts src/install/service.test.ts --quiet'
```

Proof of each line of the ticket, all in `src/install/service-launchd.test.ts` with a `launchctl` stand-in that models the domain (a `bootstrap` of a loaded label fails with 5, and a `bootout` takes a `print` or more to finish, which is the failure the ticket reports):

- a first registration bootstraps: "a first registration bootstraps, as it always has";
- a re-run with the same plist restarts with `kickstart -k`: "a re-run with the same plist kickstarts the loaded service with -k";
- a re-run with a changed plist is `bootout`, a wait, then `bootstrap`: "a re-run with a changed plist boots the service out, waits until launchd lets go of the label, and only then bootstraps";
- `agent-org start <service>` twice in a row exits 0 both times: "`agent-org start instance` run twice in a row exits 0 both times";
- update's restarts: "update's restart of a loaded service ...", "update's restart of a registered service that is not loaded bootstraps it ..." and the two `reloadService` tests;
- a failure's message: "a failed bootstrap says which service, what launchctl said, and the one line that fixes it" (no `root`), "the message of a failed bootstrap is the sentence the ticket asks for, word for word", and the enable, disable, kickstart, exit-status and wait-ran-out cases.

The After-merge line of the ticket (`agent-org onboard` twice in a row on the laptop) runs on a Mac: `agent-org onboard && agent-org onboard && agent-org status instance` exits 0 and prints `instance: running (launchd io.github.agent-org.instance)`.

Consumer-declaration: none -- no option is added to a project declaration. `ServiceDeps` gains an optional `pause`, which every existing caller leaves unset.
