---
"@a11ign/agent-org": patch
---

The daily retro's read keeps each acceptance file and merged-PR mark as it reads it, so a tick the gate cuts mid-class resumes from the files already read instead of reading them again. A class that reaches its tick budget stops inside itself, is not kept as read, and the retro offers no order until every class is read.
