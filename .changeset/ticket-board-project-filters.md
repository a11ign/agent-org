---
"@a11ign/agent-org": minor
---

A ticket-mode worker now chooses the repository itself: it starts in the ticket's own folder beside the host file's `clones`, reads the ticket, and makes its worktree with the new `ticket:worktree <repo>` command, which keeps the branch rules in code. The board shows the repositories once they are made. Nobody picks a repository: the Pick tab's repositories bar is gone, and `POST /api/queue` no longer takes `repos`. The Pick tab also filters by Linear project (several at once, with counts) beside the search and folds each status group, both remembered in the browser. The page's logic is a tested module (`board-view.ts`), served to the browser with Node's type stripping.
