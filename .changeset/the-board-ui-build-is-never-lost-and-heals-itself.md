---
"agent-org": patch
---

The board's UI build is no longer lost after an update, and the board heals itself when it is. The prune that follows an update now keeps the newest older release that holds a UI build, which is the build the board falls back to while `current` has none. Before this, the prune removed it, so the Updating page had nothing behind it. Each UI fetch now stages under its own name, and a build that is already whole is never deleted for one that is not ready, so two fetches racing leave a build and not none. While the Updating page is shown, the ui service fetches the missing build itself, at most once a minute and behind the update lock, so it does not wait for an update timer that a sleeping Mac never fires. `agent-org doctor --fix` fetches a missing build, and doctor's fix line says so. An update now always says when the build is in place.
