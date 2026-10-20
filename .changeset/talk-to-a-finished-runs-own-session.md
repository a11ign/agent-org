---
"agent-org": minor
---

A finished run has a **Talk to it** action on the board: it opens the run's own saved session in a new pane, in the browser terminal, so a person can message the agent. It answers a planner's question that no terminal could reach before (a batch planner's `QUESTION.md` was closed with its workspace), and it takes a problem with a draft pull request to the worker that wrote it. The session is resumed with `claude --resume`, so the agent has everything it knew, and a prompt tells it a person is here, to wait for them and to hold its outcome as `needs-human` meanwhile, which parks the run with its terminal open as any run handed back is. The run it replaces goes back on the board as it was when no session can be found or the pane fails to start. Not offered for a run that concluded (`checked`, `done`, `planned`), was stopped, is completed or canceled, or already has its terminal open.

Every action and link on a run is now an icon, with a tooltip saying what it does and its words kept in the page for a screen reader: Remove, Stop, Retry, Close, Approve, Respond to review, Talk to it, Start anyway, Dismiss, Apply edit, Discard edit, Open terminal, each pull request, and the Slack message.
