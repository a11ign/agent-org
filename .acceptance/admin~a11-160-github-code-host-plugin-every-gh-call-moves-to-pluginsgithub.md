Row mode's GitHub calls are now the GitHub plugin's, which is the fourth of A11-160's steps: the GitHub adapter of the ticket port and the 24 files of reads and writes that `src/ticket-port/` held moved unchanged into `plugins/github/rows/`, behind an optional `rows` group of the code host contract (version 1.7, `docs/adr/0007-…`). Each operation still takes the `run` its caller hands it, so the gate's timeout, memo and call census still apply, and `src/ticket-port/<file>.ts` keeps a delegate with the old name and signature, so no caller changed. `src/ticket-port/` holds no `gh` call, and the call ratchet no longer exempts it. A program that reaches the rows with no activated code host loads the host file's by `require`, and a program that only reads rows by label loads none of the project's declaration. `docs/gh-call-baseline.json` does not rise (only its `about` text changes). Row mode's core tests run the plugin's `rows` over their stubbed `run`, and the contract suite checks `rows` where a code host has them. The ratchet's baseline is not yet zero: the gate, wake, claims, merge and the rest move in steps 5 to 9.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github src/plugins/rows.test.ts src/plugins/active.test.ts src/plugins/boundary.test.ts src/plugins/built-in.test.ts src/plugins/loader.test.ts src/plugins/fakes src/ticket-port src/packaging/gh-call-ratchet.test.ts src/packaging/gh-call-inventory.test.ts src/packaging/git-spawn-classification.test.ts src/packaging/no-search-reads.test.ts src/close-rows-sweep.test.ts src/provider-low-confidence.test.ts
! git diff origin/main -- docs/gh-call-baseline.json | grep -E '^\+ {4,}'
test -f plugins/github/rows/adapter.ts && test -f plugins/github/rows/rows-by-label.ts && test -f plugins/github/rows/index.ts
test -z "$(grep -lE '\["(api|pr|issue|run|label|project|repo|release)",' src/ticket-port/*.ts | grep -v '\.test\.ts$')"
scratch=$(mktemp -d)
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" }, "codeHost": { "provider": "github" } } } }' > "$scratch/host.json"
AGENT_ORG_HOST="$scratch/host.json" node src/bin.ts plugin list | grep -qE '^  github  *enabled  *contract 1\.7  *plugins/github$'
AGENT_ORG_HOST="$scratch/host.json" node --input-type=module -e 'const { rows } = await import("./src/plugins/rows.ts"); process.stdout.write(rows().tracker)' | grep -qx github
: > "$scratch/decisions"
env -u AGENT_ORG_HOST node src/provider-low-confidence.ts --question=model-routing/x --since=1d --log="$scratch/decisions" | grep -q 'not-asked'
rm -rf "${scratch:?}"
```

Consumer-declaration: none -- no host file changes meaning: `tickets.providers.codeHost` keeps its shape, and no other repository reads `src/ticket-port/`. A host file that names `provider: "github"`, or no code host block, resolves to the bundled plugin as before.
