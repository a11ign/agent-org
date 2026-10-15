---
"@a11ign/agent-org": minor
---

`pr:open` opens a pull request in the repository the row's Region names when that is not the tree's own. It read `refs/remotes/origin/<head>` in the tree it ran from, which is not the other repository's remote, so a branch pushed to a11ign/agent-org for an a11ign row was refused as "unreadable -- push the branch first" whatever was pushed (a11ign#4889: the row stalled with finished work and `ceo` opened the draft by hand). It now reads the branch from that repository (`gh api repos/<repo>/branches/<branch>`), compares it with the local commit the Acceptance runs on, and sends the create, the arm and the session label to that repository. A repository that holds no such branch, holds another commit, or cannot be read refuses, naming the repository and the branch; a Region of the tree's own repository, or one spread over several, is read as before. agent-org#753.
