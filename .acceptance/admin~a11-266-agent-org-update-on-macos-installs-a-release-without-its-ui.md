`agent-org update` installs the UI build a release declares, or fails and leaves `current` where it was; it says `✓ UI build for vX installed (N files)`; `current` never moves to a release that declares a build and has none; a nothing-newer update whose build is missing and cannot be fetched fails after the status file is written; `doctor` fails (not warns) on a declared, missing build and names `agent-org update`; on macOS the migration loads each rewritten, loaded launchd job again (not the auto-update job that runs the update, which it says so about on stderr). The fetch runs through a `tar` that behaves like macOS's bsdtar.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/ui-asset.test.ts src/install/update.test.ts src/install/doctor.test.ts src/install/tool-migrate-launchd.test.ts src/packaging/git-spawn-classification.test.ts
```

Consumer-declaration: none -- no host file or setting changes meaning. `doctor`'s `ui build` row now reports a failure where it reported a warning, and its fix is the one it already named.
