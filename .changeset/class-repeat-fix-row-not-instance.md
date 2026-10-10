---
"agent-org": patch
---

A failure-class repeat row is no longer counted as an instance of its own class, so closing it cannot re-trip the `class-repeat` alert it answers. `classRowArgv` filed the gate's repeat row with `--label class:<id>` and `rowOf` counted every closed row carrying one, so the fix became instance N+1 the moment it closed and, being the newest, the discriminator of the next offer (`hold-on-idle-row`, 2026-10-09: #4674 closed and the class "first tripped" in the same second, quoting it as the third occurrence; `owner-unresolved` was inflated the same way by #4624). The class row is now filed without the label, and `rowOf` skips any closed row titled as the class row of some class, whatever labels the classifier (#4633) or a hand put on it. Nothing about a genuine occurrence changes: a row without that title is counted exactly as before. a11ign/agent-org#570.
