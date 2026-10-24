## What it is

`ui/src/api/` is the board UI's data layer (A11-189, part of A11-187): a typed client with one method per route the board calls on an instance, `mutate` (the one helper every change goes through, which hands the server's refusal back as data), and `usePoll` (polling every 5s while the page is visible, backing off 2s doubling to 60s after a failure, with `loading | ready | empty | error | unreachable` and the last good data). Its answer types are `import type`s from the server's modules; the server gains named, exported types for answers it built inline (`ConfigView`, `QueueView`, `ConnectionsView`, ...) and no route, status or answer changes.

## Acceptance

The unit tests (`pnpm ui:test`, the `components` project) cover the request each method makes, the refusal as data, backoff timing under fake timers, visibility pausing, and unreachable versus error using `proxy()`'s real answers. The check below also runs the typecheck, then renames the field `/api/writer` answers (`runs`, which `writersAreEmpty` reads) and shows `pnpm ui:typecheck` fail naming `src/api/` (the UI package's own path), then restores the file and shows it pass.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
npm run typecheck
pnpm ui:typecheck
pnpm --dir ui exec rstest run --config rstest.config.ts src/
trap '"'"'git checkout -- src/ticket-mode/server.ts'"'"' EXIT
sed -i "s/return { runs: (queue.writers/return { rows: (queue.writers/" src/ticket-mode/server.ts
grep -q "rows: (queue.writers" src/ticket-mode/server.ts || { echo "FAIL: the rename did not apply"; exit 1; }
OUT=$(pnpm ui:typecheck 2>&1 || true); echo "$OUT" | grep -E "error|Result"
if echo "$OUT" | grep -q "src/api/.*error"; then echo "a renamed field fails the UI typecheck"; else echo "FAIL: the UI typecheck did not notice"; exit 1; fi
git checkout -- src/ticket-mode/server.ts
pnpm ui:typecheck'
```

Consumer-declaration: none -- the client is code in `ui/` with no page yet (A11-194 builds the first), and no option is added to a project declaration.
