`outsideArmPass` puts back to a draft an approved draft it readied and `arm-pr` then refused; a draft that is armed stays ready. `src/packaging/outside-arm-refusals.test.ts` drives both.

Acceptance:
```bash
node --test src/packaging/outside-arm-refusals.test.ts
```

Mutation: removing the `restoreDraft()` call before the refusal/failure naming fails the new refusal test and no other (measured, 15 pass / 1 fail).

Consumer-declaration: none -- a change inside `outsideArmPass`, which the gate already calls; no new module.
