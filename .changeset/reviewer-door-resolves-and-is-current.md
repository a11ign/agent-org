---
"agent-org": patch
---

The reviewers' verdict door resolves and is kept current (a11ign/a11ign#3316, found on #3311). Orders now print `$HOME/reviewer/bin/pr-review-verdict`, the path `install-reviewer-bin.sh` writes to, because `~/reviewer/bin` is on no PATH and the bare name was `command not found` for a reviewer that had finished its review. `host:check` reads the installed door against the shipped one and reports it `DRIFTED` or `NOT INSTALLED` (a clean report says `CURRENT`), and `host:install` runs the installer, which keeps the previous copy as `.bak-<stamp>` and reads the install back byte for byte.
