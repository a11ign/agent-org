---
"agent-org": minor
---

`gate-snapshot-read rows --json` prints the open rows the gate last read as ONE JSON object, `{ source, readAt, ageMs, rows }`, with each row's number, title, labels and body as the store holds them. A row the store has no body for prints `"body": null`, never `""`, and a row with no stored label list prints `"labels": null`, so a caller reads "no hold written" apart from "the store holds no body" (a11ign/a11ign#5575 reads a fleet hold off each row's body with it). `readAt` is the instant the gate read the rows and `ageMs` the time since, never negative. Without `--json` the text output is unchanged. `--json` on `prs` or `board` is refused with the usage line and exit 2, not ignored; a missing store is still said on stderr and exits 1.
