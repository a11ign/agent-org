The GitHub code host is now a bundled agent-org plugin, `plugins/github`, behind the code host contract (version 1.1), and this is the first of A11-160's steps: ticket mode's six reads of a pull request (the feedback and the account the workers act as, the reviewer's reading of a pull request and its state, a repository's open pull requests, and the stacked-pull-request retarget sweep) run through the plugin core loads at start, with the stacking-extension doctor rows, the onboard step and the update upkeep that were core's. The built-in `github` row and its pin are gone, the plugin passes `runCodeHostConformance`, and core's tests build on the fake code host. The gh-call ratchet now reads `src/`, `scripts/`, `plugins/` and every shell script, exempts `plugins/github/` (and `src/ticket-port/` while it holds calls), and its baseline only grew by the six files the wider scan newly sees, at the count each holds. Row mode, the identity wrapper, the verdict door, merge and the gate are later steps: the baseline lists what still calls `gh`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github src/plugins src/packaging/gh-call-ratchet.test.ts src/packaging/gh-call-inventory.test.ts src/packaging/bin-commands.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/review-command.test.ts src/ticket-mode/review-claim-two-pools.test.ts src/ticket-mode/providers.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/server.test.ts src/install/doctor.test.ts src/install/onboard.test.ts src/install/update.test.ts src/install/gh-account.test.ts
scratch=$(mktemp -d)
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" } } } }' > "$scratch/host.json"
export AGENT_ORG_HOST="$scratch/host.json"
node src/bin.ts plugin list | grep -qE '^  github  *enabled  *contract 1\.1  *plugins/github$'
! node src/bin.ts plugin disable github 2>"$scratch/refused"
grep -q 'github is the only code host, and exactly one code host must be enabled' "$scratch/refused"
node src/bin.ts doctor > "$scratch/doctor" || true
grep -qE '^(ok|FAIL) +gh stack: ' "$scratch/doctor"
grep -qE '^(ok|FAIL) +code host \(github\)' "$scratch/doctor"
test -f plugins/github/package.json && test ! -e src/ticket-port/pull-feedback.ts && test ! -e src/ticket-port/stack-retarget.ts
rm -rf "$scratch"
```

Consumer-declaration: none -- no existing host file changes meaning: `tickets.providers.codeHost` keeps its shape (`provider: "github"`, `enabled`, `identity`, `gh`, `stack`), the old `gh` and `github.identity` keys are read as aliases as before, and a host with no code host block runs the same plugin. The Settings page draws the same code host rows, and doctor keeps the names of the rows it had (`gh stack`, `stacked pull requests`). `src/ticket-port/pull-feedback.ts`, `stack-retarget.ts`, `stack-live-check.ts`, `stack-extension.ts` and `src/install/stack-account.ts` are not files another repository reads, and `ticket:stack-live-check` runs from `plugins/github/stack-live-check-command.ts` under the same command name.
