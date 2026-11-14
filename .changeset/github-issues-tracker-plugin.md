---
"agent-org": minor
---

A second tracker plugin, `github-issues` (A11-447, step 1 of 2): the open issues of one GitHub repository are the board's tickets, read and written through GitHub's REST API with a token. It passes the tracker contract suite, as `linear` does. States are `state:` labels and the issue's open or closed state, priorities are `priority:` labels, a label group is the part of a label before `: `, a project is a milestone, and sub-issues and blocked-by are GitHub's own; `plugins/github-issues/README.md` gives the whole mapping. Core's remaining Linear assumptions, and an end-to-end run on a fixture whose tracker is GitHub Issues, are step 2.
