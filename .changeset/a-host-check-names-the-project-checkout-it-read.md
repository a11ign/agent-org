---
"agent-org": patch
---

`host:check` and `host:install` print, as their first line, the project checkout and HEAD the project's units were read from: `project units read from <checkout> @ <short sha>, <n> files` (a11ign/agent-org#1505). Two readings from two directories no longer disagree silently. `host:install` lists each unit it will remove, and the directory it compared against, before it removes anything. A project units directory that exists and holds none of its units, while `a11ign-*` units are installed, is a PROBLEM line, and `host:install`'s remedy says it would remove every installed unit it does not ship.
