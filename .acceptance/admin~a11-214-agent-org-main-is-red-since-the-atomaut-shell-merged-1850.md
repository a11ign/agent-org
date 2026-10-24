## What it is

The shell's page check no longer races the island (A11-214). `/next/runs/<key>` is served as the runs page, so its heading and title say "Runs" until the island hydrates and names the run; the `it.each(ROUTES)` row read the heading once, straight after the sidebar (which is in the static HTML), and lost that race on a slower runner. The row now waits for the hydrated heading and title before it reads them. A new check holds the island's scripts for a second and shows the page is "Runs" first and "A11-1" / "Atomaut: Run detail" after. Only `ui/test/shell.page.test.ts` changes; no code under `ui/src/` or `ci.yml` does.

## Acceptance

The shell page checks pass, five times in a row, and so does the whole UI suite.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:build
for run in 1 2 3 4 5; do pnpm --dir ui exec rstest run --config rstest.config.ts test/shell.page.test.ts | grep VERDICT; done
pnpm ui:test | grep VERDICT'
```

Consumer-declaration: none -- a test file only; nothing is exported or read by another package.
