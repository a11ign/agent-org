---
"agent-org": patch
---

Every agent session the board starts has a private `TMPDIR`, and the board clears the legacy entries out of the shared `/tmp` itself (A11-303). The reviewers the board starts (and a new-ticket run and a publish run) were opened with no `TMPDIR`, so their acceptance and mutation runs refilled `/tmp` at about 440 entries an hour. `openPane` now makes `<private base>/run-t-<label>` for every pane the board opens and names it in the pane's environment; the sweep keeps the directory of a session herdr lists and removes it once herdr no longer does. The same sweep removes, a bounded number a pass, the entries in `/tmp` the agent owns that are a day old and open by no process. The host check's `/tmp` alert names the top prefixes of the entries modified in the last hour, so a new leak points at its source.
