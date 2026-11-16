The UI's dev dependency `pixelmatch` is 8.0.0 on `main` (Dependabot's bump, a11ign/agent-org#2085, merged by the queue with `gate` green). This file records that bump's acceptance. Its API is unchanged, and under its new colour metric every responsive capture still matches its committed baseline within the tuned limits: `PIXEL_THRESHOLD` stays 0.1 and `DIFFERENCE_THRESHOLD` stays 0.005, and no file under `ui/captures/responsive/` changes. 8.0.0 counts about 5 to 14% more differing pixels than 7.1.0 on the same pair; the worst capture, `runs-820x1180.png`, moves from 0.2417% to 0.2642%, still under the 0.5% allowed.

Acceptance:
```bash
set -e
trap 'git checkout -- ui/captures && git clean -fdq -- ui/captures' EXIT
git fetch -q origin main
grep -q '"pixelmatch": "8.0.0"' ui/package.json
grep -q '^  pixelmatch@8.0.0:' ui/pnpm-lock.yaml
grep -q '^export const PIXEL_THRESHOLD = 0.1;' ui/test/responsive/baselines.ts
grep -q '^export const DIFFERENCE_THRESHOLD = 0.005;' ui/test/responsive/baselines.ts
git diff --quiet "$(git merge-base origin/main HEAD)" -- ui/captures/responsive
pnpm --dir ui install --frozen-lockfile --ignore-scripts
pnpm --dir ui exec playwright-core install chromium
(cd ui && npx rstest run --config rstest.config.ts --project node test/responsive/baselines.test.ts)
(cd ui && pnpm run build && npx rstest run --config rstest.config.ts --project pages test/responsive)
```

Mutation: set `DIFFERENCE_THRESHOLD` to 0.002, and the pages check fails with "runs-820x1180.png differs from its baseline in 0.26% of its pixels", so the comparison runs on 8.0.0 and is not skipped.

Consumer-declaration: none -- a dev dependency of the private UI package; no server, `/api/*` or host file change.
