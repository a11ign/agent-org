---
"agent-org": patch
---

The `tick-cost` line names the GitHub-status call as a phase of its own (a11ign/a11ign#3730, split out of #3723): `work-tick` reads the wall from the line the gate already prints on stderr (`github-status: operational (call N ms).`, `github-status: UNKNOWN (...; N ms)`, or the `GITHUB INCIDENT:` line) and reports it as `phases["github-status"]` beside `gate`, so the call is readable on every tick against #3566's target without a person grepping the journal. The phase has a `wallMs` and no `cpuMs`, because the gate timed it and nothing measured its CPU; it sits inside `gate`'s wall, so the two are read beside each other and never added. A line that is absent, or says `wall not read`, adds no phase and no failure. Nothing else changes: no new call, no new order, and the status fetch, its timeout and its cache are as #3723 left them.
