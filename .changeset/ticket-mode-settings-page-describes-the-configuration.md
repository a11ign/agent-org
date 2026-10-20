---
"agent-org": minor
---

Ticket mode's Settings is a page at its own address, `#/settings`, in place of the dialog. It describes every key the machine's `host.json` (and its `tickets` block) and each project's `.agent-org/project.json` accept: what the key is for, its value, whether it is enabled, disabled, not set or at its default, and which file the value comes from, with what breaks when it is wrong. A key file or secret path shows its path and whether the file exists, never its contents. A file the tool refuses shows its refusal, and the rest of the page still renders. The plugins section says whether a worker's session would load each plugin, and the connector and deny rules are said in plain words. The editable controls (the new-run, planning and ticket-writer model and effort, and workers at once) keep their behaviour. The page reads `GET /api/settings`, which is read-only.
