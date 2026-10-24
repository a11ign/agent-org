---
"agent-org": patch
---

`GET /api/plugins` also answers the Claude Code plugins the host file lists in `tickets.plugins` (`claude`: each one's install, its fix sentence, the contract it declares and its contract rows) and how many plugins need attention (`attention`: agent-org plugins that failed or have a failing check, packages the registry refused, and Claude plugins that do not load, whose health is unknown, or that have a contract row). The answer to a plugin action names the backup the save kept (`backup`). Nothing else about the plugins, their checks or their actions changes (A11-201).
