---
"agent-org": minor
---

`row-file --board=<n> --lane=<owner>` boards an `epic`-labelled row (a11ign/a11ign#4456). An epic has no Region, Acceptance or Open-check, so the claimability refusal it shares with `--promote=` could never let it onto Project 1, `row-off-board` named it every tick, and a human boarded it with raw `gh project item-add`. An epic now skips the body check (and only that: a closed or claimed epic is still refused), boards at Status Backlog with `backlog` and its lane label, and never gets `ready`. `promoteGate` is split into `openUnclaimedGate` and `claimableBodyRefusal` to allow it. The `row-off-board` order now names `--board=<n> --lane=any` for an epic.
