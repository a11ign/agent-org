---
"agent-org": patch
---

Ticket mode's Settings page chooses the ticket writer's model and effort, beside the worker's and the planner's, with the same choices. A choice is stored in `choice.json` as `writerModel` and `writerEffort`, wins over `tickets.writer.model` and `.effort` until it is cleared, and the first option of each, Host default, clears it. It applies to the next New ticket request with no restart: each request is stamped with the model and effort it runs on, the run starts on that stamp, and its card shows it. A request queued before this change, with no stamp, starts on the host file's values.
