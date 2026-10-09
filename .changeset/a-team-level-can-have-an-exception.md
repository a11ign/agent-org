---
"agent-org": minor
---

`team-access-drifted` can now be told that a team is deliberately kept at another level on one repository. A team in the project's access declaration may carry `exceptions`, `{ "<owner>/<name>": "<level>" }`, and the signal then expects that level there instead of the team's `layer`: a team held to `push` that is meant to stay off a repository (`"none"`) is clear when it holds nothing there and tripped when it holds anything else, so a repository kept off on purpose no longer trips for as long as it is declared. `admin` is still a trip anywhere and is refused as an exception's level; an exception naming a repository the declaration does not list, naming an unknown level or not a map is `CANNOT_TELL` with the reason, never ignored. A declaration with no `exceptions` behaves exactly as before. a11ign/a11ign#4467.
