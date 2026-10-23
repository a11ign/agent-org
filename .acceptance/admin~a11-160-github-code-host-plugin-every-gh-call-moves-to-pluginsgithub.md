Arming a pull request, guarding its merge and running the merge queue's dispatcher are now the GitHub plugin's, which is the fifth of A11-160's steps: `arm-pr`, `auto-arm-sweep`, `merge-guard` (with its lookups and the armed-race rule), `merge-queue` and `pr-armed-state` no longer hold a `gh` argument list or a parse of GitHub's answer. What each asks of GitHub is a named operation of the code host's `rows` (contract 1.8, `docs/adr/0008-…`), implemented in `plugins/github/rows/` (`armed-state`, `arming`, `sweep-reads`, `merge-guard-reads`); the decisions stay in core and call them. `run` is optional on those operations: a caller that has not moved (the gate, the outside home, the importers of `merge-guard/lookups.ts`'s `gh`) hands its own, one that has moved hands none, and the plugin runs `gh` itself. `CodeHost.armMerge` is real (the arm, the settle poll, the read-back). Core's tests of the moved callers run on the fake code host's rows (its world models what arming and the guard read, and `failures` refuses an operation by name); what an operation sends and how it reads GitHub's answer is tested in `plugins/github/rows/`, and the tests that spawn the real programs with a stub `gh` on PATH moved there too. `docs/gh-call-baseline.json` only goes down: seven files left it (the five callers, the armed-race rule and a file whose entry was already stale) and two entries are lower. The ratchet's baseline is not yet zero: the gate, wake, claims and the rest move in steps 6 to 9.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github src/plugins src/packaging/gh-call-ratchet.test.ts src/packaging/gh-call-inventory.test.ts src/packaging/git-spawn-classification.test.ts src/packaging/live-default-seams.test.ts src/packaging/merge-method-is-one-fact.test.ts src/packaging/arm-refuses-open-blocker.test.ts src/packaging/arm-refuses-an-ejected-pr.test.ts src/packaging/arm-pr-row-repo.test.ts src/packaging/outside-arm.test.ts src/packaging/outside-arm-refusals.test.ts src/packaging/merge-queue.test.ts src/packaging/merge-guard.test.ts src/packaging/merge-guard-lookups.test.ts src/install/doctor.test.ts src/ticket-mode/server.test.ts
node --input-type=module -e 'import { execFileSync } from "node:child_process"; import { readFileSync } from "node:fs"; const before = JSON.parse(execFileSync("git", ["show", "origin/main:docs/gh-call-baseline.json"], { encoding: "utf8" })).files; const after = JSON.parse(readFileSync("docs/gh-call-baseline.json", "utf8")).files; const rose = Object.entries(after).filter(([file, entry]) => !(file in before) || entry.spawns > before[file].spawns || entry.calls > before[file].calls).map(([file]) => file); const left = Object.keys(before).filter((file) => !(file in after)); if (rose.length > 0 || !left.includes("src/arm-pr.ts") || !left.includes("src/merge-queue.ts")) { console.error("the baseline rose for", rose, "or the moved callers are still in it; left:", left); process.exit(1); }'
test -f plugins/github/rows/arming.ts && test -f plugins/github/rows/armed-state.ts && test -f plugins/github/rows/sweep-reads.ts && test -f plugins/github/rows/merge-guard-reads.ts
test -z "$(grep -lE '\["(api|pr|issue|run|label|project|repo|release)",' src/arm-pr.ts src/auto-arm-sweep.ts src/merge-queue.ts src/merge-guard.ts src/merge-guard/*.ts src/pr-armed-state.ts | grep -v '\.test\.ts$')"
test -z "$(grep -lE 'execFileSync|spawnSync|"gh"' src/arm-pr.ts src/auto-arm-sweep.ts src/merge-queue.ts src/merge-guard.ts src/pr-armed-state.ts)"
scratch=$(mktemp -d)
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" }, "codeHost": { "provider": "github" } } } }' > "$scratch/host.json"
AGENT_ORG_HOST="$scratch/host.json" node src/bin.ts plugin list | grep -qE '^  github  *enabled  *contract 1\.8  *plugins/github$'
AGENT_ORG_HOST="$scratch/host.json" node src/bin.ts doctor 2>&1 | grep -qF 'code host: github (enabled, contract 1.8, plugins/github)'
mkdir "$scratch/bin"
printf '%s\n' '#!/bin/sh' 'echo "stub gh: $*" >&2' 'exit 1' > "$scratch/bin/gh"
chmod +x "$scratch/bin/gh"
mkdir "$scratch/project"
cp -r src/packaging/fixtures/project-tree/. "$scratch/project"
sed -i "s|@@PROJECT@@|$scratch/project|" "$scratch/project/.agent-org/host.json"
git -C "$scratch/project" init -q
git -C "$scratch/project" add -A
git -C "$scratch/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "the fixture project"
AGENT_ORG_HOST="$scratch/project/.agent-org/host.json" PATH="$scratch/bin:$PATH" node src/arm-pr.ts --pr=1 --repo=a11ign/agent-org 2>&1 | grep -q "arm-pr: could not read #1's labels"
rm -rf "${scratch:?}"
```

Consumer-declaration: none -- no host file changes meaning: `tickets.providers.codeHost` keeps its shape, and no other repository reads `arm-pr`, the sweep, the merge guard or the merge queue as a library (a11ign's own workflow runs them as commands, whose flags and exit codes are unchanged). A host file that names `provider: "github"`, or no code host block, resolves to the bundled plugin as before.
