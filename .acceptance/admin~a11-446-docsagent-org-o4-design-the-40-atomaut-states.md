Step 2 of 2 of A11-446: PARITY.md has no `pattern:` row left. The 36 rows step 1 left are `designed:` rows, each linking its captures in `ui/captures/`. Most captures already existed; `parity.page.test.ts` adds eleven states and writes them to `ui/captures/parity/`: four Run detail pages whose "Everything this run noted" holds the run-card notes (the shared batch session, Waits on and Stacked on, publishing off, the started-anyway note and the cut list, a restart's note, a done run's evidence, and the verdict, retarget, check and merge queue notes), the connections file refused, the quiet Reconnecting line after a focus read, an old board's `/?connection=…#run-KEY` link sent on to the run on the named instance, a stale answer for the instance switched away from that is not drawn, the settings read's notes, an instance older than the page, and the plugins read's host note. Each new scene asserts what it shows. `parity.test.ts` now refuses a `pattern:` row, holds every `designed:` link to a 390x844 capture beside its 1440x900 one, and fails if any pattern row is left.

Acceptance:
```bash
(cd ui && npx rstest run --config rstest.config.ts --project node test/parity/parity.test.ts)
(cd ui && pnpm run build && npx rstest run --config rstest.config.ts --project pages test/parity/parity.page.test.ts)
test "$(grep -c '| pattern:' docs/design/atomaut/PARITY.md)" = 0
```

Consumer-declaration: none -- no host file key changes meaning.
