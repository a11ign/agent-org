---
"agent-org": minor
---

The gate's product share now follows `adopterFacing`. A Region entry under a `dora` repository the project declares `adopterFacing: false` no longer counts as a PRODUCT row for the engineer pool's 6-of-10 floor (`offeredByShare`, `recordEngineerStarts`), so a sweep of such a repository reads as `org`, is recorded as an org start, and is held back while the share is below the floor and a product row is offerable. A row with any entry under an adopter-facing repository stays product, and a project that declares no `adopterFacing` is read exactly as before. The gate still never idles an engineer to hold the ratio: with no product row offerable it prints `NO PRODUCT ROW OFFERABLE` and offers every row. a11ign/a11ign#4399.
