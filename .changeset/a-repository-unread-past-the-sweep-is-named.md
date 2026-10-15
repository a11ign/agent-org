---
"agent-org": patch
---

An org-health reading now names a repository whose last whole read is older than the sweep plus one tick (`GRAPHQL_SWEEP_MINUTES` + 2.1 min), with its age, so a repository that goes unread for longer than the sweep promises no longer waits unseen. a11ign/agent-org#1418 (found on a11ign#5408, where nine partial ticks ran between 20:00Z and 21:10Z and three pull requests waited about 20 minutes with no alert). A repository with no stamped whole read is reported as UNKNOWN (`CANNOT_TELL`), never as clear. Poll hosts, which stamp no whole reads, are not asked.
