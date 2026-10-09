---
"agent-org": patch
---

`src/review-depth.ts` adds the review-depth seam: `reviewDepth` answers `light`, `normal` or `full` for a pull request, as data. A workflow, an auth or token path, `SECURITY.md`, `.claude/rules/` or a closed row's gate-bearing path is `full` by code with no question asked; otherwise three atomic questions over a trimmed state go to the decision provider, and no provider, a refusal or low confidence is `normal`. Nothing calls it yet: the reviewer's order in `wake.ts` is a follow-on. a11ign/a11ign#4635.
