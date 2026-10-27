`agent-org update` ends every run by installing what the installed release ships to the agents host (the unattended mode of the host install, run from `<tool>/current`, never from a checkout): the units, the launcher, the workers README, the `gh` wrapper and seat wrapper, the reviewers' door and the row-review skill. A file it replaces is kept beside the new copy as `.bak-<stamp>` and the changed lines are logged. A timer installed and `disabled`, an orphan unit, and the root and dotfile items (kdump, pstore ACLs, Codex trust) are left as findings. `host:check` no longer reports `host-install-pending` for host.json's `tool` checkout on a host that runs the installed tool.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/host-units/keep-previous.test.ts src/install/host-install.test.ts src/host-units/host-install-unattended.test.ts src/install/update.test.ts
```

Consumer-declaration: none -- no host file changes meaning. The install a person runs without the unattended flag does what it did, and now also keeps a file it replaces beside the new copy.
