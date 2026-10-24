## What it is

On the second laptop's first onboard, herdr was not installed and nothing installed it or said how: the web terminal, the herdr integrations and the herdr, instance and ui services all failed, and doctor showed 9 FAILs. This change makes onboard install herdr, at the version the release pins, as its first step.

## Change

- `src/install/herdr-install.ts` (new): `TOOL_HERDR_VERSION = "0.9.3"` (the version the agents host runs), `installHerdr`, `handInstallCommand`. The install runs the steps of herdr's own installer against the `releases["0.9.3"]` entry of `https://herdr.dev/latest.json`: the asset for this machine, its SHA-256 check, the binary written to a side file in `$HERDR_INSTALL_DIR` or `~/.local/bin`, `--version` checked to print the pin, then moved into place. It never uses the manifest's top-level (newest) entry and never falls back to it.
- `install.sh`: `HERDR_VERSION=0.9.3` beside `PNPM_VERSION`; preflight notes a missing herdr (`agent-org onboard installs herdr 0.9.3`) and never fails on it; `--verbose` shows the present herdr's version.
- `src/install/onboard.ts`: `ensureHerdr` is the first step. A failed install prints `✗ herdr was not installed: <why>`, the hand command, and stops (exit 2) before the profile, the clones, any write, any plugin step or any service. `finishOnboard` also refuses to start any service when herdr has gone from PATH since. A herdr already on PATH, at any version, is left alone.
- `src/install/doctor.ts`: the `herdr` row's fix is `agent-org onboard` and the pinned hand command for the machine; the `herdr version` row compares with the pin and warns (still `ok`) on any other version, with the pinned step in place of `herdr update`.
- `src/install/service.ts`: the herdr unit's refusal names `agent-org onboard`.
- `README.md`: Prerequisites, `onboard`, `doctor` and "Kept up to date" say the same.
- Auto-update is unchanged: it never installs, upgrades or restarts herdr (A11-184, A11-169's ADR 0004).

## Acceptance

Lint has no errors, typecheck passes, and the install tests pass: onboard with no herdr installs it (stubbed) and then starts the services; a failed install stops before anything is written, run or started; doctor's fix names the command; the pin in `herdr-install.ts` equals `install.sh`'s.

Not exercised before merge: a real download from herdr.dev and GitHub, and a fresh onboard on a machine with no herdr. The chairman session runs the second after merge.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/herdr-install.test.ts src/install/onboard.test.ts src/install/doctor.test.ts src/install/install-sh.test.ts src/install/herdr-service.test.ts'`

Consumer-declaration: `OnboardDeps` gains `arch`, `installHerdr` and `putOnPath`, and `DoctorDeps` gains `arch`; both are internal to this repository's onboard and doctor, and their only callers are `onboard.ts`, `doctor.ts` and their tests.
