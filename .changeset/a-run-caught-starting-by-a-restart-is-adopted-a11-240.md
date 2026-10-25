---
"agent-org": patch
---

A restart of the instance no longer ends a run that was in its first minute as "crashed: the pool restarted while it was running" while its worker carried on (A11-240). On start-up every run the queue holds as `starting` or `running` is looked up in herdr by its name: one herdr lists with a pane is adopted, a `starting` one included; one whose pane is gone ends "lost in a restart" and is queued again once if the board has no pull request on record for it. A run already marked crashed whose pane herdr lists `working` is taken back on the next watch pass. The card says which of these happened.
