---
"agent-org": patch
---

A board page the tab has drawn before draws its last data at once after a click in the sidebar, and refreshes it in place, instead of starting again from a blank skeleton. Each read's last good answer is kept in the tab's `sessionStorage` for its instance and path (the connections list too), so Tickets, Runs, a run's page, Machine, Models, Workers and Plugins draw while their reads are still in flight; storage that is refused or full is simply not used. Until the instance's own answer arrives, the controls that write (Save, Restore, plugin actions, run verbs, Queue and Grill on Tickets, the worker pool, the model selects) wait, so nothing acts on data that has changed since. A page whose SSH instance cannot be reached draws its last data under the existing unreachable frame, and the Plugins page now shows the proxy's last known plugins as the Unknown board when it holds none of its own. A11-270.
