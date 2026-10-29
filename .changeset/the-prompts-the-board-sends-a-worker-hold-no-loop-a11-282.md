---
"agent-org": patch
---

The board thread no longer holds its loop for three of the prompts it sends a worker's pane (315 ms a call, `herdr agent prompt`): the CI-budget warning, the notice of a pull request the run waits on that has trouble, and the wake that says push access is fine. They go through `sendToAgentAsync` (`ctx.herdrCall`), so the board's figure "synchronous holds an hour" no longer counts them. A run that is stopped while herdr answers is not ended `needs-human` by the waited-pulls watch afterwards, nor logged a push check by the lost-push wake.
