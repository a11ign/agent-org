---
"agent-org": minor
---

Every chairman message now declares who it is for, and the sender routes by it (a11ign/a11ign#4742, row 1 of 5 of the split of the one chairman chat). Each messaging kind carries an `audience`: `request` and `stall` are an `ask` (they need the chairman), and `incident`, `summary`, `release`, `milestone` and `watch` are an `announcement` (told to him, asking nothing). A kind with no audience is refused at send, with a ledger line naming the kind (`alert not sent: kind "<kind>" declares no audience`), and is never defaulted.

`messaging.announcementsFile` is a new, optional key of `.agent-org/project.json`: a secret reference like `chairmanFile`, holding the chat id of a one-way announcements channel. Absent, both audiences go to the chairman chat exactly as before. The Telegram provider takes `announcementsChatId` and routes an announcement there; it refuses `actions` on an announcement, and `replyTo` into the channel, so a message that needs an answer cannot reach it. `provider.send` takes `audience` and returns the audience it applied; `capabilities.destinations` says whether a provider has one destination or two, and `runProviderConformance` holds a provider to all of it. Nothing reads `announcementsFile` into a running watcher yet: that wiring is a later row of the split.
