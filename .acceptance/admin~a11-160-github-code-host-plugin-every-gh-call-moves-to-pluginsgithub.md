The routing `gh` wrapper, the App-token minter and their checks are now the GitHub plugin's, which is the second of A11-160's steps: `host/gh`, its renderer and the rules about writing it (A11-84's: a wrapper that names no App never replaces one that does), `app-token.ts` and the authoring switch's script moved into `plugins/github` behind an optional `wrapper` group of the code host contract (version 1.3). Core's `host:install`, `host:check`, the tick's re-render and the instance's start-up ask the activated code host for the wrapper's text, install target and refusals, and still write the file. Doctor's `gh wrapper` and `app token <role>` rows, the new `wrapper roles` row (the roles the installed wrapper routes to an App, against the roles `host.json` declares) and onboard's App-key step are the plugin's own, and the App-token rows run on a ticket-only host too. The wrapper renders from the moved template byte for byte but for the two programs it runs, which moved with it. `docs/gh-call-baseline.json` loses `host/gh` and nothing rises. What core still holds of the identity machinery (wake's token-cache reader, the event feed's App JWT, `gh-identity.ts`, `gh-conditional.ts`, `app-role-silent.ts` and the author-fallback signal) is read by gate, org-health and reviewer code that moves in later steps, and ADR 0003 says so.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github src/plugins src/app-token-cache.test.ts src/app-role-silent.test.ts src/packaging/gh-call-ratchet.test.ts src/packaging/gh-call-inventory.test.ts src/packaging/gh-wrapper-guard.test.ts src/packaging/host-project-paths.test.ts src/packaging/host-units.test.ts src/packaging/gh-author-fallback.test.ts src/packaging/reviewer-app-role.test.ts src/packaging/github-identity-declaration.test.ts src/install/doctor.test.ts src/install/onboard.test.ts src/ticket-mode/server.test.ts
! git diff origin/main -- docs/gh-call-baseline.json | grep -E '^\+[^+]'
git diff origin/main -- docs/gh-call-baseline.json | grep -qE '^-    "host/gh": \{'
test ! -e host/gh && test -f plugins/github/wrapper/gh && test ! -e src/app-token.ts && test -f plugins/github/app-token.ts
scratch=$(mktemp -d)
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" }, "codeHost": { "provider": "github", "stack": false, "identity": { "reviewer": { "mode": "github-apps", "appId": "1", "keyPath": "/nonexistent/reviewer.pem" } } } } } }' > "$scratch/host.json"
export AGENT_ORG_HOST="$scratch/host.json"
node src/bin.ts plugin list | grep -qE '^  github  *enabled  *contract 1\.3  *plugins/github$'
node src/bin.ts doctor > "$scratch/doctor" || true
grep -qE '^  ok +gh wrapper: not applicable' "$scratch/doctor"
grep -qE '^  FAIL +app token reviewer: .*app token: key: /nonexistent/reviewer\.pem cannot be read' "$scratch/doctor"
rm -rf "$scratch"
```

Consumer-declaration: none -- no host file changes meaning: `tickets.providers.codeHost` keeps its shape (`provider`, `enabled`, `identity`, `gh`, `stack`), the old `gh` and `github.identity` keys are read as aliases as before, and the installed `~/.local/bin/gh` of a live host is re-rendered by the instance's start-up check (and by `agent-org host:install`) with the two program paths that moved. `host/gh` is not a file another repository reads: the wrapper is installed by copy, never linked. `src/app-token.ts` and `src/gh-author-fallback.ts`'s script are programs only the wrapper ran.
