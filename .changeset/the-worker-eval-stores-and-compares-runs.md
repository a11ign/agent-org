---
"agent-org": minor
---

The worker eval stores and compares its runs (A11-431, step 2 of 2). A run of a set is stored by its set and sha under `<stateDir>/evals/`, and `node scripts/run-eval.ts compare --set <set> <A> <B>` prints two runs side by side, each score's change per ticket and in total. `--key <switch>=on|off` runs a set with one switch of the host file on or off, for a feature that ships off. The new host-file key `tickets.evalTokenCap` (300,000,000 tokens by default) stops a run before its next ticket once the cap is reached, and the run says how far it got. `evals/sets/first.json` is the first set of ten merged agent-org tickets, and `docs/run-eval.md` gives its measured cost.
