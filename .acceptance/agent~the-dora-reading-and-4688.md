`dora.ts` now decides releasability through `isShipped` (imported from `release-behind-main.ts`, not copied) and honours a `no-release:` reason when the merged-PR reader supplies the body (`gh pr list` now asks for `body`). A test file or changeset under a releasable path is no longer a releasable change for deployment frequency, lead time or the unreleased count; a truncated file list still counts.

Evidence (measured on this branch): the acceptance test passes 3/3. Mutation: replacing `isShipped(...)` in `dora.ts` with the old bare prefix match fails 2 of the 3 tests (the derived-population agreement and the `src/x.test.ts` fixture). Other `dora*`/`org-retro*` suites: `dora-channels`, `dora-lead-time-reads-are-bounded` and `dora-releasable-agrees-with-shipped` pass; `dora-direct-to-latest-has-no-channels`, `dora-release-commit`, `org-retro-dora-resumes` and `org-retro-merged-repositories` fail identically on unmodified `origin/main` `4de1251`, measured by running them against `HEAD:src/dora.ts`.

Acceptance: `cd ~/repos/agent-org-wt-4688 && node --import tsx --test src/dora-releasable-agrees-with-shipped.test.ts`

Closes a11ign/a11ign#4688

platform: n/a (reading logic)
