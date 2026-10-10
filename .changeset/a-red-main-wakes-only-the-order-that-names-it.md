---
"agent-org": patch
---

A red main wakes only the order that names it, not every manager order. The wake triage read `mainRed` (the trunk's state, which the tick sets on every order) as a reason to wake WITHOUT asking, so for as long as a main was red none of a manager's orders could be digested (200 of 200 `via: none` orders on 2026-10-10 sat inside one red window). Now only the red main's own order (cause `trunk-red`) and a chairman direction wake before the provider is asked; any other order sent while main is red is asked as usual, is still told `mainRed`, and `names-red-main` is the question that wakes it.
