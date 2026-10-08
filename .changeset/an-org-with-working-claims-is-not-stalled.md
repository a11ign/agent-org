---
"agent-org": patch
---

`org-stalled` no longer counts a claimed row whose session herdr lists as `working`. `openRowState` counted every open row that declared no wait and read no claim, so on 2026-10-08T19:05Z nine claimed rows (two of their workers started minutes before) paged `ceo` as "could move and are not moving". `deadMansSwitch` now takes herdr's listing (`agents`), subtracts the reachable rows with a `working` `session:` label (`workingClaims`), and the order says how many it left out. It reuses the listing `readOpenRowFollowUps` already reads once per tick for `closedClaimsWhenWorkerListed`, so it adds no `herdr` spawn and no `gh` call. A session that is idle, `blocked`, absent from the listing, or a listing that could not be read (`null`) leaves the row counted, so a stall under a dead claim still pages. a11ign/a11ign#4205.
