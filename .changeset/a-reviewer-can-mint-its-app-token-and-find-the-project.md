---
"agent-org": patch
---

A reviewer instance can mint its GitHub App token and run a keyed repository's Acceptance again. `reviewerEnvironment` sets `A11Y_APP_TOKEN_DIR` to `node_modules/.cache/app-tokens` in the instance's own tree, beside the npm cache it already writes there, because `host/gh`'s default token directory is read-only in the reviewer's sandbox. Since agent-org#1347 a failed mint refuses the reviewer's call, so a reviewer could not post once the token an unsandboxed caller had cached expired (agent-org#1342). A keyed repository's reviewer also gets `AGENT_ORG_HOST`, as every worker does (#850): an agent-org checkout declares no project, so an Acceptance that imports the vocabulary refused at import in review (agent-org#1378) while it passed in the worker's pane. The primary's reviewer gets no `AGENT_ORG_HOST`, because its checkout declares its own project.
