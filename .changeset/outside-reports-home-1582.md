---
"agent-org": minor
---

`agent-org outside-reports <ci-health|outsider-verdict|token-cost|weekly-review>` runs one of a project's weekly reports from the org's side (agent-org#1582, epic "agent-org stands alone"). It is behind `outside.reports` in the project's `.agent-org/decisions.json` (absent is off, and off does nothing at all) and runs the script the project names in `units.reports.<name>`, so a project that declares none runs none. `token-cost` and `weekly-review` are host reports and are refused under GitHub Actions (a runner has no session transcripts and no board credential). `.github/workflows/org-reports.yml` runs the other two on a schedule, only where the repository variable `OUTSIDE_REPORTS_PROJECT` names a project. Nothing in the project changes: its own jobs run beside it, and each report is idempotent per period, so a second actor posts nothing.
