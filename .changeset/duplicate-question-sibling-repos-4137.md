---
"agent-org": patch
---

The board-truth audit's `duplicate-or-superseded` question no longer reads sibling per-repository rows as one row (a11ign#4137, found on #4130 and #4132-#4135). Two titles that each name a repository in the form `a11ign/<name>` (lower-cased, a trailing `.` not part of the name) and name different sets of repositories are not near-duplicates. A title naming none, or two naming the same repository, are compared by words exactly as before, so a real twin is still found. `Superseded by #n` is unchanged.
