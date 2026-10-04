---
"agent-org": patch
---

The work gate no longer asks a reviewer for a first verdict on a pull request that conflicts with its base (a11ign/a11ign#3476). `draftOrder` read red, then a settled green head, and never asked whether the pull request could merge, so a DIRTY one sat in the reviewer lane as a clean one does: #148 was approved 7m42s after #145 made it DIRTY, at a head the rebase had to replace. A `CONFLICTING` pull request now gets no `draft-awaiting-verdict` order; its owner's `pr-merge-conflict` order already says the rebase is owed, and once it is pushed the head is new and the review is asked once, at the head that can merge. An unread merge state (`UNKNOWN`) still asks for the review, and a verdict already given (rework owed, a convinced draft not yet ready) is still acted on: only the request for a first look is withheld.
