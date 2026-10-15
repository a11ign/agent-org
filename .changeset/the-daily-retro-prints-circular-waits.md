---
"@a11ign/agent-org": patch
---

The daily retro prints a `Circular waits` line beside the top blocker line: how many circular waits the gate found in the last 24 hours, how many of those were broken, the longest one in minutes, and how many still stand (`- Circular waits: 2 found (1 broken, longest 90 minutes; 1 standing)`). Zero found prints `0 found`; a `blocking-impact.json` that was not read or does not parse prints `unknown`, never `0 found` (agent-org#930).
