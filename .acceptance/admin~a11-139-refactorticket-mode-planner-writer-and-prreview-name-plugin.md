The three host keys `tickets.planner`, `tickets.writer` and `tickets.prReview` keep their readers and their refusals, which now say which extension point each key is. `agent-org doctor`'s `ticket writer` check takes its answer from the skill the enabled plugin's declared contract provides, not from the words of `tickets.writer.run`: a skill the contract does not provide fails it, a writer whose plugin declares no contract passes and says so, and the install record is read once per doctor run, shared with the plugin checks. A reader that accepts a skill name the plugin does not provide is left as it was: `contractRows` is the check that finds it.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/settings.test.ts src/install/doctor.test.ts src/ticket-mode/plugins.test.ts src/ticket-mode/plugin-contract.test.ts
npm run typecheck
npm run lint
```

Mutation: the base production files (`doctor.ts`, `plugins.ts`, `plugin-contract.ts`, `settings.ts`) were copied into a scratch copy and run against the new tests. Seven went red: the A11-94 writer case (its detail changed), the five `A11-139: the ticket writer ...` and writer-skill cases in `doctor.test.ts`, and `A11-139: the contract a session loads ...` in `plugins.test.ts`. The reader-to-contract test in `plugin-contract.test.ts` passed on the base, as a behaviour this change keeps. The rest of the 121 passed on both.

Consumer-declaration: `pluginProblems` gains the field `contracts`; its callers `pool-prepare.ts` and `settings-read.ts` read named fields and are unchanged. Nothing else reads the detail text of the `ticket writer` check (`grep` of `src/` finds no reader of it outside the doctor and its tests).
