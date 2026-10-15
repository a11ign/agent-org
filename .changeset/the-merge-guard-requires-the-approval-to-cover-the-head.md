---
"@a11ign/agent-org": minor
---

The merge guard decides whether an approval covers the head, replacing GitHub's last-push-approval rule, which marked an approval stale on every merge-base change. An approval covers the head when every PR commit after the approved one is a merge from `main`; any other commit after it turns `gate` red with `APPROVAL DOES NOT COVER THE HEAD`. Comments never count, a later `CHANGES_REQUESTED` replaces an approval, and an unreadable review or compare is `CANNOT_ASK`, never covered. a11ign/a11ign#5038.
