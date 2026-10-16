---
"agent-org": patch
---

The tool reads the home repository's name from the project declaration (`.agent-org/project.json`) instead of writing it in code. The review door (`reviewer/pr-review-verdict.sh`) no longer defaults `GH_REPO` to that name: with `GH_REPO` unset it reads the repository from the declaration beside it, and refuses (exit 2) when the declaration cannot be read.
