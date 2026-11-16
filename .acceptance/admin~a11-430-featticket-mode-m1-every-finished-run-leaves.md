The board's Outcomes page (A11-430, step 3 of 3) draws `/api/outcomes` by model and effort, repository and label, and every figure lists the runs behind it, each linking to its run's page. The page checks answer `/api/outcomes` with the instance's own route (`outcomesAnswer`) over a scratch outcome log and host file, so the figures, the "at configured prices" words and a price changed in the host file are the backend's. Steps 1 and 2's tests run here too.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/outcomes/
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui exec rstest run --config rstest.config.ts --project components src/outcomes src/shell
pnpm ui:build
pnpm --dir ui exec playwright-core install chromium
pnpm --dir ui exec rstest run --config rstest.config.ts --project pages test/outcomes test/routes.page.test.ts test/dist.page.test.ts test/shell.page.test.ts test/responsive/responsive-captures.page.test.ts
```

Mutation: in `OutcomesPage.tsx` return `client.outcomes(query)` itself as the read (so the tab keeps each week's answer), and "keeps no week's answer" fails. In `outcomes-model.ts` make `figureOf` give a rate's `runs` in place of its `of`, and "lists the runs a rate is out of" fails. In `route.ts` price at `pricesOf(undefined)`, and "uses a price changed in the host file when the page is read again" fails.

Consumer-declaration: a new page, `/outcomes`, and an Outcomes link in the sidebar's Main navigation. No API or host file change.
