---
"agent-org": patch
---

A model or effort choice on the Settings page keeps showing what was saved when the page reads `/api/config` again while the save is in flight (A11-294). The answer was recorded against the config the change started from, so a read that landed first replaced it and the select fell back to the older value; it is now recorded against the config the page holds when the answer arrives. This was an intermittent failure of the `ui` check.
