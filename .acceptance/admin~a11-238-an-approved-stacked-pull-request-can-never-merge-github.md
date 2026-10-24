Refs A11-238

Step 1 of 2 (agent-org): the arm bot merges a stacked pull request with GitHub's stack merge. `arm-approved` reads the pull request's `stack` field; a pull request that is not in a stack still goes to `gh pr merge --auto --merge`. A stacked one (its base is `main`, so it is the bottom open member) whose required checks are green is merged with `PUT /pulls/{n}/merge-async` for its own number only, pinned to its head, with the same Octo STS token. A refusal is one keyed comment (`<!-- agent-org:stack-merge head=<sha> -->`) carrying GitHub's message, edited in place. The `arm` job writes nothing for a stacked pull request. The policy, triggers and token are unchanged.

Acceptance:

```bash
node --test src/packaging/auto-arm-stack-merge.test.ts src/packaging/auto-arm-workflow-honours-hold.test.ts src/packaging/auto-arm-octo-sts.test.ts
npm run typecheck
```
