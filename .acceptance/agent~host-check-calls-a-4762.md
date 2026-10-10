`host:check` expects a persistent seat on the `model` its roster entry declares (#4740) and no longer calls it an undeclared model, and its `/model` remedy names the declared model rather than the org's Sonnet. A seat declaring nothing, a `tier:haiku` worker and an unreadable roster are judged exactly as before. A declared alias resolves to the id the org names for it (`haiku`, `sonnet`), a `[1m]` suffix is dropped, and an alias with no id in this file (`opus`, `fable`) is not a finding: those seats are unchecked, a stated limit.

Mutation: six, each turns at least one test red and each restore was byte-identical (`diff` of a copy under the scratchpad, never `git checkout --`): the roster ignored so the new path never fires (3 red); the roster path expects an id nothing carries so it always fires (2); an alias with no id read as a finding (1); the `[1m]` suffix not dropped (1, after the first run of this mutant survived and a case was added: a `sonnet[1m]` seat answering from Haiku); the remedy naming `sonnet` (2); the `tier:haiku` branch dropped (2, in the older #4457 test and the new "as before" one).

Evidence: the three new tests fail on `origin/main`'s `host-units.ts` (152 pass, 3 fail) and pass with the change, 155 of 155 in `src/packaging/host-units.test.ts`. The existing `sessionModelDrift` tests now hand in `seatModels` too: left to default they would read the roster of whatever project the suite runs from. LIVE, read-only, through the real `sessionModelDrift()` on this host with `AGENT_ORG_HOST` at the a11y-witness checkout: v0.120.0 source reports `session liaison: SESSION ON AN UNDECLARED MODEL` (its last answer came from `claude-haiku-5-5`; the org declares `claude-sonnet-5-5`), and this branch reports 0 findings. `agent-org host:check` itself is NOT run here: Done-when 2 is read after the release. Limit: `opus` and `fable` aliases carry no id in `src/`, so a seat declaring one is unchecked; the `[1m]` suffix handling is not checked against a live transcript.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4762 && node --test src/packaging/host-units.test.ts'`

Closes a11ign/a11ign#4762

History: full

`host-units.test.ts` reaches `shippedUnits` (`addedOnSomeRef`, `git log --all`), which needs the real answer a shallow checkout cannot give; the line above is why the acceptance job is handed full history.

platform: checked the `claude` CLI, which resolves a `--model` alias itself and exposes no listing this check could read, so the table is the one the file already holds (`DECLARED_CLAUDE_MODELS`, `HAIKU_MODEL_ID`) and no new alias table was added.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
