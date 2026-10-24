---
"agent-org": patch
---

`/api/queue`'s `update` now also carries `next`: the version an `agent-org update` is moving the instance to while it runs (the folder it is building, or the version `current` names once swapped and before the restart), read from the update's own lock and folders and null otherwise. A board page left open uses it to show the update in progress, instead of a plain "Reconnecting…", when the restart comes. Nothing the update does changes, and the current page ignores the field.
