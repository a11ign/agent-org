---
"agent-org": patch
---

The gate's `pr-codeowner-review-missing` no longer names a pull request on the strength of another repository's with the same number (a11ign/a11ign#3720). It matched each PR to its files by number alone, so `lab#3` (one file, `packages/lab/package.json`) was named because `toolchain#3` touches a workflow, and `ceo` was ordered to review a dependency bump twice; the same defect could also leave a PR that does touch an owned path unnamed. The files are now keyed by repository and number (`subjectRef`, the gate's own spelling), so a tracker PR and a sibling's with one number stay two entries. The other number-keyed maps in `work-gate.mjs` read one repository each (the tracker's rows, the primary's open PRs) and are unchanged.
