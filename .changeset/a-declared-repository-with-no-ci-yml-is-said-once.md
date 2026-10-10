---
"agent-org": patch
---

A declared code repository that has no `ci.yml` (a11ign/.github) no longer makes the tick print `gh: Not Found (HTTP 404)` twice every tick (a11ign/agent-org#693). `readTrunkRed` reads a 404 on the runs read, told from a 403, a 5xx or a timeout by `gh`'s `(HTTP 404)` text, as "no trunk workflow here": `null`, said once per repository per day (`<repo>: no <workflow> on main, so its trunk is not read`) and not asked again until a marker file in the state directory is a day old. A repository whose marker says it HAD the workflow and now answers 404 stays `undefined` (unread, not green) and is said every tick. `gh`'s stderr is captured in the call, and a refusal that is not a 404 still writes it.
