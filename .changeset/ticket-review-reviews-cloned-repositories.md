---
"agent-org": patch
---

`ticket:review` and the tickets' reviewer start a reviewer for a pull request of a repository the host clones (`clones` in `host.json`) under the primary's owner, with no entry in the project's `code`. The reviewer checks out in that clone and its verdict posts to that repository (a11ign/agent-org A11-128). Before, it was refused as "not a repository the project declares". A repository neither declared nor cloned is still refused, naming both `project.json` and `host.json`.
