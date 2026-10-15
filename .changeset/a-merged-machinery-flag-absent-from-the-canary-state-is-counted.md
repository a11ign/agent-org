---
"@a11ign/agent-org": patch
---

The `flag-without-a-switch` org-health reading also counts a machinery flag whose home is the canary state (`machinery-canary.json`) when it is merged more than two hours and still absent from that state, with no open `ready` or `in-progress` row naming it. The canary state is read through the reader `machinery-flag.ts` uses, and an unreadable canary file, a merge date git cannot give, or an open-row read that did not happen makes the reading unknown rather than clean (a11ign/agent-org#1324). `gate.graphqlPacing` is the flag this first finds.
