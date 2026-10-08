---
"agent-org": patch
---

An unanswered `epic-finished` or `epic-unfiled` order is now escalated to `ceo` like the other standing causes (a11ign#4044, found on a11ign#4042). `STUCK_SUBJECT` matched `row-<n>`, `pr-<n>`, `pr-<key>#<n>` and `trunk-<key>-<sha8>` but not an epic's cause key (`product-manager/epic-finished/epic-<n>`), so `escalateStuck` could not read the epic as a row and the order went silent at `MAX_DELIVERIES`. It now reads `epic-<n>` and the keyed `epic-<key>#<n>`; the primary's epic is labelled `answer:ceo`. A keyed epic is reported as `STUCK ... cannot be escalated` rather than labelled on the primary (the same number is another row there) or filed as a `Stuck trunk-red` row (it is not a red).
