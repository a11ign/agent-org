---
"agent-org": minor
---

Ticket mode stacks a blocked ticket on its blocker's pushed branch, not only on an open pull request (A11-116). A run starts on top of a blocker once that blocker's branch is pushed in the repository the run works in, with or without a pull request, and its pull request is based on that branch. A ticket's repository defaults to its Linear project's, read from the `github.com/<owner>/<repo>` address in the project's summary, unless the planner names another; the board says "the worker chooses the repo" only for a project with none. When the blocker's branch moves, agent-org rebases the stacked run onto it once its worker has stopped, from the commit it was branched at, and a rebase that conflicts is left to a person. A Blocked run says why it waits.
