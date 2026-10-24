## What it is

`ui/` is a new private package: Astro with React islands, strict TypeScript, static output (`output: "static"`, `base: "/next"`, no adapter), Inter and JetBrains Mono bundled from Fontsource, a dev server that proxies `/api/*` to this machine's instance, and a test harness (rstest for components, the proxy and the page checks; `playwright-core` for the page and the screenshots at 1440px and 390px, failing on horizontal overflow). One placeholder page proves the chain. Root scripts `ui:dev`, `ui:build`, `ui:test` and `ui:typecheck` call it, the root ESLint config covers `.tsx` and `.astro`, CI runs a `ui` job that `gate` waits for, and the README says how to run it.

## Acceptance

The UI typechecks, builds, and its tests pass (components, dev proxy, config, the build's fonts and static files, the placeholder's page checks and screenshots), lint reports no error, and the CI tests that read `ci.yml` hold the new `ui` job and the `gate` that needs it.

Acceptance: `bash -c 'set -e; pnpm --dir ui install --frozen-lockfile --ignore-scripts; pnpm --dir ui exec playwright-core install chromium; pnpm ui:typecheck; pnpm ui:build; pnpm ui:test; npm run lint -- --quiet; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ci-ui-job.test.ts src/ci-lint-job.test.ts src/ci-changeset-on-push.test.ts'`

Consumer-declaration: none -- nothing under `src/` changes except three tests that read `ci.yml` and `package.json`; the UI is served nowhere yet.
