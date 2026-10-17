---
"agent-org": patch
---

Nothing under `.github` or `src` names the pin-bump class, fact, route or measure any more, since agent-org#1593 deleted the pin they served. `ci-failure-class.ts` loses the `waiting-on-pin-bump` class, the `wait-for-pin-bump` route and the `waitsOnPinBump` fact (the classifier is five classes and five routes); the daily retrospective loses its "pin and bump" read and line, so `pin-bump-measure.ts`, its tests and the `retro.pinBump` machinery flag (registry entry and ledger entry) are deleted; `outside-nightly.yml` no longer names `project-ref-bump.yml` as its precedent.
