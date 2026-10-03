---
"agent-org": patch
---

A Telegram send whose `fetch` rejects (no response at all) is now a `TelegramSendError` like every other failed send, so it is logged, and on part 2 or later of a split message it says how many parts WERE delivered; it used to pass through unannotated and unlogged, and the core's whole-message retry then sent the chairman a duplicate with no stated cause. Every request now has a 30-second deadline (`deadline`, injectable like `sleep`), after which it is abandoned and reported as a failure rather than holding the send until the process is killed.
