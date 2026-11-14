Linear's calls go through the one outside client (A11-436, step 1 of 3): a 503 twice and then an answer is one read that succeeds and one failure in the figure; a 401 is not retried, because one rule classes it as refused; ten failed attempts in a row open a service's breaker, which then refuses at once and says the service is unavailable; an attempt that never answers fails as transient at its time.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/outside-client.test.ts plugins/linear/linear.test.ts src/plugins/loader.test.ts
```

Mutation: in `src/ticket-mode/outside-client.ts`, add `"refused"` to `RETRIED`, and the 401 test fails (`[linear.made(), waits]` is `[4, [200, 800, 2000]]`). Make `note` record every attempt with `ledger.record`, and the 503-twice test fails (`calls: 3`).

Consumer-declaration: none -- no host file key changes. `PluginDeps.retryFetch` is replaced by `PluginDeps.outside`; the only tracker plugin is bundled and moves with it.
