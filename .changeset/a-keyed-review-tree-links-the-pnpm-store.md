---
"agent-org": patch
---

A keyed review tree links the clone's `.pnpm` along with its `.bin`. pnpm's shims in `.bin` find their package by `$0`-relative path without following the symlink, so a tree that linked `.bin` alone had shims pointing at a store that was not there, and a keyed reviewer of a pnpm repository could not run `pnpm exec <bin>` and posted an escalation instead of a verdict (screenreader-fleet#2). The clone is still never written, and its other dot entries are still not linked. a11ign/a11ign#3728.
