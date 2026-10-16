---
"agent-org": patch
---

The outside home of a project's `ownedPaths` job reads the flag `outside.ownedPaths` and ships OFF (#1598). `shadowOwnedPathsVerdict` asks for no verdict unless the flag is a literal `true`; on, it records the owned-path sign-off verdict of each agent pull request (its `files` and `body` against the project's `docs/owned-path-facts.json`) beside the job's and blocks nothing. An outside pull request meets no sign-off request.
