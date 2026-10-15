---
"@a11ign/agent-org": minor
---

`row-file` refuses a build row whose ` ```spec ` block is missing a required field or has an empty one (agent-org#1015, the validation half of a11ign#5109's structured format): `files`, `tests` (`path`, `cases` with `given`/`when`/`then`), `run` and `out_of_scope` are required, a `then` that asserts nothing is refused, and so is a second block. A row with no `spec` fence is exempt. Behind `rows.specBlock` in `.agent-org/project.json`, absent meaning OFF; revert is the flag off. `specBlockRefusal` is exported for the promote path and the spec lint (a11ign#5117).
