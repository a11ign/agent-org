---
"agent-org": patch
---

A claim that names no branch and no worktree (a host act, a fleet or lab reading, a hand-claim) now writes its own claim record, `Claimed-nothing: <reason>` under the marker, instead of nothing. The stall check used to skip such a claim with `claim-stall: #N carries session:S but no claim record names when or where -- not evaluated` on every tick, so an abandoned one could not be told from a live one; it now reads the record's own time and the claimant's comments like any claim, and the nudge applies. A claim with no git object is never released by the stall check: a stalled one stays `nudged`, and the blockedBy and gone-holder releases ("holds nothing built") leave it held. A release is still spelled `released by` with no field, so the two never share a spelling, and releasing a nothing-claim posts the release record so a later claim that wrote nothing does not inherit the old one's time (a11ign/a11ign#3407).
