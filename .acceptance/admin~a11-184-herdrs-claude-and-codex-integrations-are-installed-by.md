## What it is

After a herdr upgrade the `claude` integration read `outdated (v8 < v10)` and the herdr web ui stayed on a commit from before its newest release, because onboard installed neither at a version and nothing kept them current (A11-184). Onboard now installs both integrations on every machine, the web ui at its newest release tag; every auto-update run re-installs an outdated or missing integration and moves the web ui to its newest release tag; doctor fails an integration that is not current and warns when herdr or a herdr plugin is behind.

## Change

- `src/install/herdr-upkeep.ts` (new): the integrations agent-org needs (`claude`, `codex`), the herdr plugins it installs (`devswha/herdr-web-ui`), the readers (`herdr integration status`, herdr's `plugins.json`, `git ls-remote --tags` reduced to release tags, `herdr.dev`'s newest version), the status file `herdr-status.json` doctor reads, and `herdrUpkeep`, which never throws.
- `src/install/onboard.ts`: `setUpHerdrIntegrations` (every run, `--no-terminal` or not; a failure is said with the command to run), and the web ui installed with `--ref <newest release tag>`.
- `src/install/update.ts`: `keepHerdr` in `update()`'s `finally`, beside the plugins and the conventions, whatever the move did; `herdrWiring` is the production wiring.
- `src/install/doctor.ts`: `herdr claude integration` / `herdr codex integration` fail; `herdr version` and `herdr plugin <repo>` warn (a new `warning` flag on `Check`, with `ok: true`, printed `WARN`).
- `src/install/service.ts`: `reloadService` rewrites a registered unit and restarts it, so the terminal runs the web ui's new `plugin_root`.
- `src/install/plugin-install.ts`: `runProgram` honours an `env`, which onboard always passed for bun's `PATH` and the production runner dropped.
- `README.md`: the onboard, doctor and update rows and "Kept up to date".

## Acceptance

Lint has no errors and typecheck passes. The named tests pass, with herdr, git, herdr.dev and the service manager stubbed: `herdr-upkeep.test.ts` (status parsing; re-install of an outdated or missing integration; a plugin moved from a commit and from `v0.4.12` to `v0.4.13` with `herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y`; only the running terminal restarts; a remote with no release tag moves nothing; a plugin not installed or not on the list is never touched), `update.test.ts` (the `finally` wiring, including a failed build and a drain, and the production wiring end to end), `onboard.test.ts` (both installs, a failed install, no herdr, the web ui at its tag), `doctor.test.ts` (the fail and WARN rows) and `service.test.ts` (`reloadService`).

Acceptance:
```bash
bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/herdr-upkeep.test.ts src/install/update.test.ts src/install/onboard.test.ts src/install/doctor.test.ts src/install/service.test.ts src/install/plugin-install.test.ts'
```

Consumer-declaration: none -- no contract changes: nothing in `plugins/` or the code-host, tracker or exposure contracts is touched.
