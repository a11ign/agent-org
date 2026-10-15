---
"@a11ign/agent-org": minor
---

One spec writer produces every build spec (a11ign/a11ign#5116, the Haiku push). `src/spec-writer.ts` is the gate between a one-shot Sonnet run and `ready`: the prompt is read from `.agent-org/roles/spec-writer.md` (the only prompt source; absent, or with fewer than three or more than five `### Example` headings, it refuses), the draft's tests are run on main, tests that PASS are refused as `no behaviour change specified`, tests that FAIL are committed first and their output recorded as `errors:` before the row is promoted, and a run with no exit code or no output is `cannot-ask`, never red. Behind `rows.specWriter` in `.agent-org/project.json`, absent meaning OFF; revert is the flag off. The model call, the test run, the commit and the promotion are injected: wiring the one-shot machinery (a11ign/a11ign#4505) and a11ign's flag are not in this change.
