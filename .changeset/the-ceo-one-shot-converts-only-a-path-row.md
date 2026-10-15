---
"@a11ign/agent-org": patch
---

With `workers.ceoOneShot` ON, the ceo's one-shot lane converts a ready `lane:ceo` order only when its row is a PATH row, one that names the files it changes in its Region. A DECISION row (no Region, an empty Region, or a Region that says its deliverable is not a commit) keeps the gate's order, so the standing ceo seat takes it as before (a11ign/agent-org#1138). The flag is still OFF by default, and with it OFF nothing changes.
