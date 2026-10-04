---
"agent-org": minor
---

The host runs ONE agent-org version, the newest release tag (a11ign/a11ign#3443). `update-tool` fetches tags by name and checks out the newest `vX.Y.Z` (numeric order; a pre-release and a name such as `latest` are ignored) instead of `origin/main`, prints `agent-org vX.Y.Z (<sha>)`, and with no matching tag refuses and leaves the checkout where it is, with no fallback to `main`. `host.json`'s new `toolVersion` is `"latest"` (the default) or one `"vX.Y.Z"`, which pins the host there: pinning the previous tag is the whole of a rollback, and any other value is refused by name. A move restarts the long-running units (`systemctl --user try-restart` of the chairman listener) so no process keeps the old modules, `chairman-listen` and `chairman-watch` render `node <tool>/src/messaging/*.mjs` in tool form, and `work-tick` prints `agent-org vX.Y.Z` as the first line of each tick (`liveToolVersion` is the reader a report can call).
