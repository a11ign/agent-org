---
"agent-org": minor
---

`row-file --board=<n> --lane=<owner> [--session=<name>]` boards a row that already exists (a11ign/a11ign#3330, for #3328's sweep of `regression` rows filed under `github.token`, which cannot resolve Project 1). An OPEN row on no board gets the Project item, Status Ready, then `ready` and `lane:<owner>` ADDED beside the labels it carries, and the read-back confirms all three. A row already on the board in any Status is left alone (exit 0, says so); a closed row, a claimed row, a body `--promote` would refuse, an unreadable board status and an unknown lane each change nothing and exit 1. `--board=` takes no flag but `--lane=` and `--session=`, and a malformed value never falls through to filing. `boardAndVerify` gained `session: null` (skip the Filed-by read-back for a row somebody else filed) and `lead` (its refusals no longer say "FILED as #n" of a row that already existed).
