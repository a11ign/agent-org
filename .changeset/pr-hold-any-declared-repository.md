---
"agent-org": patch
---

`pr-hold.mjs` takes, reads and releases a hold on a pull request of any repository the project declares: `--repo-key=<key>` (the key `project.json`'s `code` gives it) or `owner/repo#n`, absent being the first repository so every existing call is unchanged, and a repository the project does not declare is refused naming the declared ones. Every `gh` call, the marker comment and the re-arm read-back are aimed at that repository. The gate lifts a keyed pull request's resolved hold through the same module, released WITH its key, and reads a bare `#n` in a keyed item's `Waiting-for:` as that repository's (a11ign/a11ign#3479).
