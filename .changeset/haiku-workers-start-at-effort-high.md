---
"agent-org": patch
---

A Haiku-tier worker starts at `--effort high`, the same as the Sonnet workers, not `low`. `HAIKU_EFFORT` was the floor of `CLAUDE_EFFORTS`, assumed and never measured; `low` would have confounded the #4382 trial, since a Haiku failure could not be told apart from the effort. The Haiku profile test now pins `high`, and a mutation back to the floor turns it red. a11ign/a11ign#4522.
