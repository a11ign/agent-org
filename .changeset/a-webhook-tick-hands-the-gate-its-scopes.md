---
"@a11ign/agent-org": patch
---

In webhook mode the tick names the pull requests its events named to the gate, in a file the gate reads from `A11Y_TICK_SCOPES_FILE`, and it re-reads a repository whose dated wait has come due since the previous tick (agent-org#995). A healthy tick whose events named nothing hands over an empty list, so the gate reads nothing as changed; an unhealthy receiver, or a scopes file that cannot be written, leaves the variable unset and the gate reads whole. A corrupt due index makes every declared repository due. Poll mode is unchanged.
