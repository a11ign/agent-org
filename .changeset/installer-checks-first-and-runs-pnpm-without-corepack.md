---
"agent-org": patch
---

`install.sh` checks git, tar, Node and a way to run pnpm before it clones anything, and lists every problem at once with the command that fixes it for how Node was installed (Homebrew, nvm, fnm, or a download). pnpm 10.34.5 runs through the corepack beside node, else a corepack on PATH, else `npm exec`, and the dependencies line says which when it is not the usual one; `agent-org update` and `agent-org doctor` use the same order, so a Mac with Homebrew Node, which ships no corepack, installs and updates. The installer prints a header, one marked line per step, the outcome and the next commands, with colour only on a terminal, and ends `agent-org install OK: ...` or `agent-org install FAILED: ...` when its output is not a terminal. `--verbose` shows the mirror, the version folder and the current link (A11-185).
