---
"agent-org": patch
---

`org-health`'s red-PR signal no longer counts a red the gate is holding for a runner start (a11ign/a11ign#3731). #3723's `holdForGithubIncident` withholds a `pr-checks-failing` order whose failure is a runner start while GitHub reports an incident, but `main` handed `orgHealthNow` the orders from BEFORE that hold, so the same red still tripped `red-pr-unattended` two hours later: a second alarm for a failure the org had chosen not to act on. `holdForIncidentNow` now returns the hold's `held` beside the kept orders and `main` passes it to `orgHealthNow`, which leaves the pull requests it names out of the red-PR facts. Nothing is recorded: the first tick after the incident clears holds nothing, so the same red counts again by itself. A red that RAN and failed, and one the gate cannot classify, are counted as before. Only a rollup red (`FAILURE`, `TIMED_OUT`, `STARTUP_FAILURE`) can ever trip the signal, so a hung check or an ejection was never double-counted.
