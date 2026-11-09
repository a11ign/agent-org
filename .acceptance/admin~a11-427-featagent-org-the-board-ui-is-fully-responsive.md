The board UI is responsive on a tablet (641 to 1024px) and a phone (640px and below), CSS only, at the two breakpoints that replace the 820px collapse. At 1024px and below the sidebar is the sticky 57px top bar (the mark, the tabs, the bell, the instance chip and the search icon, each control existing once), Settings' sections and the Runs statuses hang under it as strips of pills, and Tickets offers its projects and goals as chips that open a dialog sharing the sidebar's state and handlers. At 640px and below the tabs are a fixed 64px bottom tab bar plus the safe-area inset, with the running count, hidden while any dialog is open. Every button takes a 44px hit area, a text field is 16px, the viewport covers the safe areas, and each page's tablet and phone layout follows the canvas. The page checks capture nine screens at 390x844, 820x1180 and 1180x820 and compare them with the baselines in `ui/captures/responsive/` (Linux only, ADR 0018; `UPDATE_CAPTURES=1` rewrites them), and check overflow and hit areas.

Acceptance:
```bash
(cd ui && npx rstest run --config rstest.config.ts --project node test/tokens.test.ts test/responsive)
(cd ui && npx rstest run --config rstest.config.ts --project components src/shell src/tickets src/notifications src/runs src/updating)
(cd ui && pnpm run build && npx rstest run --config rstest.config.ts --project pages test/responsive test/shell.page.test.ts test/search test/notifications)
```

Mutation: delete the `@media (max-width: 1024px)` rule of `ui/src/shell/shell.css`, and "hides the sidebar at 820px for a sticky 57px top bar" fails on the hidden `.main-nav`, and every 820px capture differs from its baseline. Delete `:where(button)::after` in `ui/src/styles.css`, and the phone hit-area checks name each compact button.

Consumer-declaration: none -- UI only; no server, `/api/*` or host file change.
