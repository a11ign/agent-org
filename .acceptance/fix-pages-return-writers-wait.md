`ui/src/shell/pages-return.test.tsx`'s "the controls that write ... waits for the instance's own answer" waits for the controls to be drawn before it checks them, instead of reading them once: a kept Tickets page draws a ticket request's Stop a tick after the rest, and the one-shot read saw none (`expected 0 to be greater than 0`), failing `ui` on #2062 and #2065.

Acceptance:
```bash
pnpm install --frozen-lockfile && cd ui && pnpm install --frozen-lockfile && pnpm exec rstest run --config rstest.config.ts --project components src/shell/pages-return.test.tsx
```

Consumer-declaration: none -- one test file under `ui/`; nothing that ships changes.
