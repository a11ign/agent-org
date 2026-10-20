The page's proxy passes `POST /api/queue/<key>/talk` on to an instance, as it does every other run action the page can send.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/remote-proxy.test.ts
```

Mutation: `talk` was taken out of the proxy's run-action list again, and the two tests that name the route went red (the fixed list and the one that reads the page's action labels); it was restored and the suite passed again.

Consumer-declaration: none -- `passedOn` is read only by the proxy, and the one route it now passes is the one the page already calls.
