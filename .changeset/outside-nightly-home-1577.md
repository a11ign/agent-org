---
"agent-org": minor
---

The project's nightly org jobs can run from agent-org's own workflow. `agent-org outside-nightly --repo=<owner/name> --only=<jobs> --report-issue=<n>` runs `ready:audit`, `trunk-sweep`, `close-rows-sweep` and `org-watch` against the named repository, from a checkout of the project, and only when the project's `.agent-org/decisions.json` has `"outside.nightly": true`; absent, `false` or unreadable is off and nothing is run. `--read-flag` prints `on=true` or `on=false` for a workflow to read. The `org-watch` finding is posted on the report issue unless a comment from the last 50 minutes already states it, so the project's own job and this one do not say it twice. The workflow, `outside-nightly.yml`, runs after the project's clocks and mints its token only when the flag is on.
