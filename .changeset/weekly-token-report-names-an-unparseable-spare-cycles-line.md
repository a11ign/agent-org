---
"@a11ign/agent-org": patch
---

The weekly token-efficiency aggregate no longer aborts when one line of the spare-cycles file does not parse (a run of NUL bytes left by a torn or concurrent append). `readInstances` (`src/wakes-per-row.ts`) skips that line and counts it: each reading prints `UNREADABLE spare-cycles lines: N skipped, not read as instances` when N is above zero, and the weekly aggregate (`src/trace/trace.ts`) names the count in its footer, on stderr under `--json 1`. Valid lines on either side are still read. a11ign/agent-org#1122.
