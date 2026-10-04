---
"agent-org": patch
---

The outcome clock reads what an idle claimed row's holder waits on, wherever the pull request is: a review requested, checks pending, an approval the queue owns, `awaiting-evidence`, and now a `hold:` put by `pr:hold --until` for an event outside the repository (the new `pr-held` kind) all read as a declared wait, where such a holder used to be `pr-owned` and never read. A per-row holder idle for 80 minutes with NO readable wait is raised as `idle-no-wait`, and `never-started` and `wait-premise-gone` are raised at their own measured 80-minute bound instead of the claimed row's 135: `boundOf` reads a per-item bound. A standing seat idle between orders is not read (a11ign/a11ign#3569)
