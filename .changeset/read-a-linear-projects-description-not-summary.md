---
"agent-org": patch
---

Every ticket read from Linear works again. The stacking release (#1772) asked Linear for `project { summary }`, which is the Linear MCP's name for a project's short text. Linear's GraphQL API has no such field on `Project` and answers 400 `Cannot query field "summary" on type "Project"`, so the Pick list, the queue refresh and every other ticket read failed. The query now asks for `description`, which is that text, under the name `summary`, so nothing downstream changes. A test checks every query that reads a project, and the fix was run against a real workspace.
