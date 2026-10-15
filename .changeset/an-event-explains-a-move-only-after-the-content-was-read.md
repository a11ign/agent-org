---
"@a11ign/agent-org": patch
---

A webhook-mode reconcile no longer treats a moved repository as explained by an event that named it before the content was read (a11ign/agent-org#1431). An event moves `bumpedAt` without re-reading anything, so a repository named after its baseline could hide a delivery the receiver never got. Held tags now keep `factsReadAt`, the time the content they were compared with was read: an event explains a move only when it named the repository after that read, and a repository no event named since then files one missed-delivery incident. The filed window starts at `factsReadAt`, not `bumpedAt`. A held tag written before this change falls back to `bumpedAt`, as before.
