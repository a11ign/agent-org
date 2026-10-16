---
"agent-org": minor
---

`agent-org outside-trunk` runs a project's trunk jobs from the org's side: the close-rows sweep, `trunk-revert-guard` and `workflow:liveness` for each new commit on the trunk, and `board:liveness`. It is behind `outside.trunk` in the project's `.agent-org/decisions.json` (absent is off, and off does nothing at all), is called paced from the host gate beside the route-outcome pass, and has a scheduled workflow that runs only where the repository variable `OUTSIDE_TRUNK_PROJECT` names a project (agent-org#1576, epic "agent-org stands alone"). Nothing in the project changes: its own `trunk.yml` jobs run beside it, and a second actor finds the rows closed and the commits answered and does nothing.
