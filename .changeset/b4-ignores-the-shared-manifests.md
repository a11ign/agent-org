---
"agent-org": patch
---

B4 no longer shelves a row on a shared manifest alone. `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` at a repository's ROOT join the changesets in the exclusion, at all three places `isChangeset` was read: the asking row's Region (`fileOverlapReason`), the other pull request's files, and `regionEntriesOf` (the claimed-row reservation). Two pull requests that each edit a different line of a manifest merge cleanly and two that edit the same line conflict, where the merge queue says so; nearly every row touches them, so ready rows sat shelved every tick (measured 2026-10-09, a11ign/a11ign#928: a11ign/a11ign#4442 and #4443 on `package.json` alone). The set is one constant, `SHARED_MANIFESTS`, matched on the path with a `<key>:` prefix stripped and at the root only: `packages/x/package.json` is another package's file and still collides, and a directory entry covering a manifest still meets the other row's entry. agent-org#464.
