---
"agent-org": minor
---

A fixed measurement (`count X at time T`) is a scheduled script, not a held session: a row that declares `Reading-script:` (one allowlisted command to start, `git worktree list | wc -l`), `Reading-checkout: <name>` and its `Reading: <n> at T` schedule has the next due reading run and posted back as `Reading <n> posted` plus `Reading <n>: <value> (<command>, <timestamp>)`. A script outside the allowlist is refused with the reason and never run; an optional `Reading-expect:` bound is only said on the row. The module is the pure runner (`src/scheduled-reading.ts`); installing it on the tick is a follow-up. a11ign/a11ign#4639.
