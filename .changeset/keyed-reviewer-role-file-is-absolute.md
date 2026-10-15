---
"@a11ign/agent-org": patch
---

A review order for a keyed repository's pull request names the reviewer's role file by its absolute path under the project root, not the relative `.agent-org/roles/reviewer.md`, which a keyed repository's review checkout does not have (a11ign/agent-org#1142). The relative path sent each such reviewer searching the whole home directory for the file, held the disk and stretched every tick. The project's own pull requests keep the relative path.
