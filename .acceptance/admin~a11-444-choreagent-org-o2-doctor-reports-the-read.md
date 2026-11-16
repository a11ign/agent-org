## What it is

Step 2 of 2 of A11-444 (O2 of the agent-org improvement backlog). The three interim guards (the gh-wrapper watchdog, the `keep-herdr.conf` drop-in and the `gh-read-cache-off.conf` drop-in) are retired on the agents host, so the code that found, reported and retired them is deleted. Step 1 (#2036) added doctor's read-cache row. This step removes all three rows with the rest of the guard code.

## Change

- `src/install/interim-guards.ts` and its test are deleted.
- `src/install/doctor.ts`: the three guard rows (`interimGuardChecks`) and the `guards` and `ghWrapperDeclared` deps are gone. The herdr scope row's `--move` fix no longer says it retires the guards.
- `src/install/onboard.ts`: onboard no longer retires guards, so the `replacements` and `removeFile` deps and the "Old workarounds retired" lines are gone.
- `src/install/herdr-move.ts`: `start herdr --move` no longer retires guards after the move, so the `retire` dep is gone.
- The tests of the deleted code are removed. In the other tests, only the fixture fields the deleted deps needed are removed, and the guard assertions in two `--move` tests.
- `docs/guide/onboard.md`, `services.md` and `troubleshooting.md` no longer describe the guards.

## Acceptance

Nothing in the tree still uses the guard code. Doctor's full row list on a working Linux install has no guard rows. The doctor, onboard and herdr tests pass against a fixture host declaration. A stand-in `tailscale` is first on PATH, so no test reaches the real one.

Acceptance:
```bash
set -e
test ! -e src/install/interim-guards.ts
if git grep -n -E "interim-guards|retireGuards|guardsPresent|interimGuardChecks|ghWrapperDeclared" -- src plugins scripts; then echo "guard code is still used"; exit 1; fi
npm run typecheck
S=$(mktemp -d); printf '#!/bin/sh\nexit 0\n' > "$S/tailscale"; chmod +x "$S/tailscale"; export PATH="$S:$PATH"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/doctor.test.ts src/install/onboard.test.ts src/install/herdr-move.test.ts src/install/herdr-service.test.ts src/no-project-names.test.ts
```
