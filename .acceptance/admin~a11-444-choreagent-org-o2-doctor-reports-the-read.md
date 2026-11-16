## What it is

Step 1 of 2 of A11-444 (O2 of the agent-org improvement backlog). `agent-org doctor` reports each of the three interim guards with the proof `retireGuards` reads. Before, a retired guard had no row. The read-cache row (`gh-read-cache-off.conf`) failed whether or not its replacement was proven, and the two herdr rows were shown only once herdr ran in its unit.

## Change

- `src/install/doctor.ts`: `interimGuardChecks` gives one row per guard on Linux. A row is `ok` (`retired: …`) when its guard is off disk. It FAILS (`… so the guard can be removed`, with the command that removes it) while the guard stands and its replacement is proven. It also FAILS (`kept: …`, with what proves the replacement) while the replacement is not proven, so a passing row always means the guard is gone. Herdr's place is read once, for the herdr scope row and the KillMode drop-in's. A new `ghWrapperDeclared` dep reads the wrapper proof, and it is asked only while the watchdog or the read-cache drop-in is on disk.
- `src/install/interim-guards.ts`: `wrapperDeclared` is exported, so doctor reads the same proof onboard does.

## Acceptance

The doctor and onboard tests pass against a fixture host declaration. A stand-in `tailscale` is first on PATH, so no test reaches the real one.

Acceptance:
```bash
set -e
npm run typecheck
S=$(mktemp -d); printf '#!/bin/sh\nexit 0\n' > "$S/tailscale"; chmod +x "$S/tailscale"; export PATH="$S:$PATH"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/doctor.test.ts src/install/onboard.test.ts src/install/interim-guards.test.ts
```
