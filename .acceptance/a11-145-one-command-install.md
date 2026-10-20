`agent-org onboard --profile <name>` sets a fresh machine up from a saved answer file (a profile, with no secret in it) and asks only for the secrets: the Linear key, and the reviewer App's private key when its file is not there yet. It writes the provider blocks, the repositories (cloned as the person's own GitHub login when missing), the conventions plugin (added from its repository, installed for every session, read back, and its declared contract sets the planner, writer and plan pattern), the house notes (written only where absent), the reviewer App's identity, and the exposure. It prints the Codex checklist for the atomic reviewer, retires the two interim guards on Linux once their replacements are proven, and ends with the doctor's checks. Doctor checks Codex under the atomic reviewer. The `KillMode` advice is gone from the herdr scope check. `agent-org update` refreshes the conventions plugin from its repository.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/onboard.test.ts src/install/onboard-profile.test.ts src/install/plugin-install.test.ts src/install/house-notes.test.ts src/install/interim-guards.test.ts src/install/doctor.test.ts src/install/update.test.ts
```

Consumer-declaration: none -- no existing host file changes meaning. An old key is moved into its block by the same migration `doctor --fix` runs, with a backup beside the file, and a host that names no profile keeps the flags-and-prompts path.
