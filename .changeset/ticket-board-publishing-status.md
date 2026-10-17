---
"agent-org": patch
---

The ticket board shows each run the publish run is posting as Publishing, with the yellow spinning ring and an Open terminal link to the publish run's own herdr pane. Before, those runs stayed Ready to merge with nothing on their rows to show a publish run was working on them. Publishing is a new status with its own filter and count, shown from the press of Publish until the publish run ends. The link fills the machine's `tickets.terminal` with the publish run's workspace and pane, which the board already holds, and shows once the publish run has a pane. When the publish run ends, each run is Published, or is Ready to merge again with the reason the board gives, as before.
