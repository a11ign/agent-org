---
"agent-org": patch
---

The board report names the agent-org version that produced it, in one line under its header, read from the tool checkout's live release tag by `liveToolVersion` and never from `package.json` (which a host's checkout can disagree with), so a report read later says which version wrote it. A checkout at no release tag prints `agent-org version not read` with the cause, never a version and never a blank (#3468, of #3443).
