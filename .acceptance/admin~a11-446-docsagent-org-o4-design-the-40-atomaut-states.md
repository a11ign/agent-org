Step 1 of 2 of A11-446: BRIEF.md's "Proposed, not yet in the code" list names nothing that is built, and its "Not designed" section becomes "Designed in the code, not on the canvas". PARITY.md gains a row for Talk to it when herdr does not open (four ways, each in Run detail's failure banner) and a row for the Claude plugins tab's states (a need not met, none listed, a plugin workers do not get, the install record unreadable). Each row's last cell is `designed:` with links to its captures in `ui/captures/`, which the page tests write. `parity.test.ts` accepts `designed:` cells, holds every link to a PNG that exists under `ui/captures/`, and holds both rows to be designed. A check row on the Plugins page now keeps its dot beside its words at 390px, where it used to sit alone on a line above them.

Acceptance:
```bash
(cd ui && npx rstest run --config rstest.config.ts --project node test/parity/parity.test.ts)
(cd ui && pnpm run build && npx rstest run --config rstest.config.ts --project pages test/plugins/plugins.page.test.ts test/run-detail/run-detail.page.test.ts test/responsive/responsive-captures.page.test.ts)
```

Consumer-declaration: none -- no host file key changes meaning.
