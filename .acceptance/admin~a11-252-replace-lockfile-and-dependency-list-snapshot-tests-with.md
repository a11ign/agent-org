A11-252 (https://linear.app/a11ign/issue/A11-252/replace-lockfile-and-dependency-list-snapshot-tests-with-invariants), agent-org's part. `src/ci-lint-job.test.ts` no longer names the versions of `eslint`, `typescript-eslint` and `@george2f/eslint-plugin-clean-code`. It names the three packages and asserts: each is in `devDependencies` with an exact specifier, and `pnpm-lock.yaml`'s root importer has the same specifier and resolves exactly that version. A Dependabot bump that moves both files passes.

Acceptance:

```bash
pnpm install --frozen-lockfile
project="$(mktemp -d)"
cp -r src/packaging/fixtures/project-tree/. "$project"
sed -i "s|@@PROJECT@@|$project|" "$project/.agent-org/host.json"
git -C "$project" init -q && git -C "$project" add -A && git -C "$project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
AGENT_ORG_HOST="$project/.agent-org/host.json" pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ci-lint-job.test.ts
pnpm run typecheck
```

**What the block shows:** 6 tests pass: the real files; a patch bump of all three tools on both sides; a range, a missing tool and a wrong lint script each fail on a copy; a manifest that disagrees with the lockfile, a drifted resolved version and a missing lockfile entry each fail on a copy.
