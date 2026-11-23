The UI's `astro check` loads `@astrojs/check` again on the `npm-minor-and-patch` group's versions (Dependabot's a11ign/agent-org#2084, carried here unchanged: `astro` ^7.4.7, `@astrojs/react` ^7.1.4, `@rstest/core` ^0.12.6, `playwright-core` 1.65.0), so the `ui` job's `pnpm ui:typecheck` passes.

## What changes, and why

- **The cause.** The group's `ui/pnpm-lock.yaml` resolves the `@emnapi/runtime` peer of `@astrojs/check`'s chain (`@astrojs/language-server`, then `@astrojs/astro2tsx`, then `@napi-rs/wasm-runtime` 1.2.4) to `2.0.0-beta.2`, which `@rolldown/binding-wasm32-wasi@1.3.0` brings in with astro 7.4.7. `@astrojs/astro2tsx` keeps `@emnapi/core` 1.11.3, and a 1.x core under a 2.0 beta runtime throws `TypeError: this.bridge.setLastError is not a function` on load, so astro prints only that the packages are "required".
- **The fix.** `ui/package.json` declares `@emnapi/runtime` ^1.11.3 as a dev dependency. pnpm resolves a peer from the importer's own dependencies first, so the chain gets `@emnapi/runtime@1.11.3`; the rolldown wasm binding keeps its own 2.0 beta pair (an optional, wasm32-only package). A `pnpm.overrides` entry scoped `@astrojs/astro2tsx>@emnapi/runtime` was tried first and does not reach a peer: the lockfile kept the beta.
- **Chromium 158.** `playwright-core` 1.65.0 brings Chromium 158, which reports a computed `align-items: flex-start` as `flow-start`, a spelling no CSS spec names. `ui/test/cutover/walk.page.test.ts` accepts either spelling; the CSS and the layout are unchanged.
- **The root `pnpm-lock.yaml`** is regenerated with `pnpm install --lockfile-only` instead of Dependabot's copy, which added importers for `ui/`, `plugins/*` and two fixtures although the root has no workspace (its stale `ui` importer still had the 2.0 beta runtime). What is left is the `playwright-core` 1.65.0 and `@rstest/core` ^0.12.6 bumps and what they pull in.
- **No changeset:** only `ui/` and the dependency manifests change, none under `src/` (`no-release`).

Acceptance:
```bash
set -e
trap 'git checkout -- ui/captures && git clean -fdq -- ui/captures' EXIT
grep -q '"astro": "^7.4.7"' ui/package.json
grep -q '"@emnapi/runtime": "^1.11.3"' ui/package.json
grep -q "^  '@astrojs/astro2tsx@0.1.3(@emnapi/runtime@1.11.3)':" ui/pnpm-lock.yaml
if grep -q "astro2tsx@0.1.3(@emnapi/runtime@2" ui/pnpm-lock.yaml; then exit 1; fi
test "$(sed -n '/^importers:/,/^packages:/p' pnpm-lock.yaml | grep -c '^  [^ ]')" = 1
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir ui install --frozen-lockfile --ignore-scripts
pnpm --dir ui exec playwright-core install chromium
pnpm ui:typecheck
(cd ui && npx rstest run --config rstest.config.ts --project node test/package.test.ts)
pnpm ui:build
(cd ui && npx rstest run --config rstest.config.ts --project pages test/cutover/walk.page.test.ts)
```

Mutation: remove the `@emnapi/runtime` line from `ui/package.json` and run `pnpm --dir ui install`: the lockfile puts the chain back on `2.0.0-beta.2`, `pnpm ui:typecheck` stops with "The '@astrojs/check' and 'typescript' packages are required", and the `@astrojs/check` test in `ui/test/package.test.ts` fails with "this.bridge.setLastError is not a function".

Consumer-declaration: none -- dev dependencies and tests of the private UI package; no server, `/api/*` or host file change.
