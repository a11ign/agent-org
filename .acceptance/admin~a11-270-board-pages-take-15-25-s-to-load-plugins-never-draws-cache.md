An SSH connection's tunnel recovers within 5 s (A11-270, step 2 of 4): a request whose forward finds the tunnel dead (`socket hang up`, `ECONNRESET`, `ECONNREFUSED`, `ENOENT`, `EPIPE`) restarts it at once and a GET is answered from a second try on the new tunnel (a POST is never sent twice); a reopen reuses the remote's port, key and terminal from the last good tunnel, so it runs no `ticket:remote-info` (a second restart with no answer between reads it again, and a third waits for an answer); the retry backoff is 500 ms doubling up to 5 s (was 2 s up to 60 s); and a request that finds the tunnel down makes a retry due within 3 s at once and waits up to 3 s for it.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/remote.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/connections.test.ts src/ticket-mode/ui-server.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/api/use-poll.test.tsx
```

Consumer-declaration: none -- the change is inside `ticket:ui`'s own process (its proxy and tunnels); no route, answer shape or file another package reads changes.
