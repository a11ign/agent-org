---
"agent-org": patch
---

A Haiku-tier worker's `--effort` is read from the ordinary worker profile (`profileFor("ready-row-unclaimed")`, `high` today) instead of being a second typed constant, so the #4382 trial changes the model and nothing else, and a change to the Sonnet workers' effort moves the Haiku one with it. `haiku-tier.test.ts` asserts a Haiku launch and an ordinary launch for the same cause carry the same `--effort`. The model, the autocompact window and the switch are untouched. agent-org#468.
