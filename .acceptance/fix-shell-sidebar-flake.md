`ui/test/shell.page.test.ts` polls the sidebar's active items, as it already polls the heading and the title, instead of reading them once after the heading settles: the island marks them as it hydrates, and the one-shot read saw none on a loaded runner, which failed `ui` on #2031 (three times) and #2035.

Acceptance:
```bash
pnpm install --frozen-lockfile && pnpm run ui:build && cd ui && pnpm exec rstest run --config rstest.config.ts --project pages test/shell.page.test.ts
```

Consumer-declaration: none -- one test file under `ui/test/`; nothing that ships changes.
