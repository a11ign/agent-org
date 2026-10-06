---
"agent-org": patch
---

`prune-tmp.mjs` prints `tmp-entries: <N>` as the first line of every run (a11ign/a11ign#3868, from #3849's done-when 2): the number of entries directly under the directory it was pointed at, read at the start of the run, so the next run reads what this one's removals left. The unit runs every minute, so `journalctl --user -u a11ign-tmp-prune.service --utc` becomes the daily record of the count, with no new unit or file. The count comes from the one `readdir` the run makes: the doomed, fixture and review lists now share it instead of each reading a directory of ~120,000 entries again (three reads before, one after). It counts dotfiles too, which `ls /tmp | wc -l` does not. A root that cannot be read prints `tmp-entries: unknown`, never `0`.
