Turns `clean-code/no-duplication` (G5) on at error in `eslint.config.ts`, after excluding the fixture project, and clears all 429 hits it reported at warn on the base (the ticket counted 406; the count had moved). Each repeated block is one of three things: a case table, now one `testEach` test per case (`src/lib/test-each.ts`, because node:test has no `test.each`); a helper that does the shared arrange steps; or a production block moved into one named function. Import lists are the one class left with a disable line each, because the rule matches statement shape and reads a run of single-name imports as a copy. Converted tables keep their assertions and their checks, but their test titles change to `title: case`, and several tests were split; the PR body lists each one.

Acceptance:
```bash
set -e
npm run lint
npm run typecheck
npx eslint src scripts --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).reduce((a,r)=>a+r.messages.filter(m=>m.ruleId==="clean-code/no-duplication").length,0);console.log("no-duplication messages:",n);process.exit(n?1:0)})'
grep -n 'no-duplication' eslint.config.ts
test -f src/lib/test-each.ts
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npx rstest run --config scripts/rstest/rstest.config.ts src/lib/test-each.test.ts $(git diff --name-only origin/main -- '*.test.ts')
```

Consumer-declaration: none -- no exported name, signature or config outside the rule's own line changed; `project-vocabulary.ts` regroups its exports by destructuring, and every name and value stays.
