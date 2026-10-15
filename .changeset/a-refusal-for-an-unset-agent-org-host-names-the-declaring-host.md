---
"agent-org": patch
---

A refusal for an unset `AGENT_ORG_HOST` made from a worktree of a clone that a host declaration's `clones` map names now names that declaration's path and the value to set (`AGENT_ORG_HOST=<path>`), where it named only the guessed `beside` path and no file to set (a11ign/agent-org#1433). The declaration is read only to name it; the refusal stays a refusal, and nothing is defaulted from it.
