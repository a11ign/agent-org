---
"agent-org": patch
---

A declared milestone coming true is told to the chairman once, with the sentence the project wrote for it. `messaging.milestones` in `.agent-org/project.json` names a file (absent means none) listing moments as `{ key, what, when }`, where `when` is a row closed, a pull request merged or a release tagged; the `milestones` source emits `milestone:<key>` the first time one holds and never again, and does not infer a milestone from a label or from GitHub's own milestones. The first complete read records the moments already true as seen and tells none of them. A condition that cannot be read is `cannot-ask`, never "not yet". `messaging:check` validates the file and refuses an entry with a missing `key`, `what` or `when` by name. This registers the `milestone` event kind in `event.mjs` and `core.mjs` (told once, never reminded, not silent) and admits `gh api` on `issues/<n>`, `pulls/<n>` and `releases` in the read-only allowlist (a11ign/a11ign#3414).
