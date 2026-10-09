---
"agent-org": patch
---

`row-file`, `row-file --promote` and `pr:open` now refuse an Acceptance command that `cd`s into the project's own primary checkout (a11ign/a11ign#4322, found on #4318). CI has no such path (the `acceptance` job died three times on `cd: /home/agent/repos/a11y-witness: No such file or directory`), and on the host the line reads the PRIMARY checkout, which carries the change only after the merge, so it passed or failed for the wrong tree; 21 open rows had it. Both spellings #4220 carries are caught, the bare `cd <path> && cmd` and the same inside `bash -c '...'`. The path is read from the host's declaration (`host.json`'s primary project), never typed into the check, and a host with no readable declaration (a CI runner) skips the check rather than guessing. A `cd` into another repository's checkout is not refused, and a body with a `Hand-run:` line keeps that declaration's meaning. `pr:open` refuses before the command is run.
