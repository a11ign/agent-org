---
"agent-org": patch
---

`row-claim claim`, `dispatch`, `decline` and `conflict` with `--tracker=<key>` now write the keyed tracker: the row is read from its repository, its labels are made and set there, its claim record is commented there, and its card moves on that tracker's own board (one `item-edit` and no snapshot; a tracker that declares no board is claimed with labels alone and says `no board declared for tracker <key>`, never the first tracker's card). The worktree is made from `host.json`'s `clones.<key>` with `git -C`, so the process's directory no longer decides which repository's `origin/main` it comes from, and a keyed claim that stops half-way is undone in the same call, the error saying what was and was not undone. A keyed row's `blockedBy` refusal names the repository (`a11ign/agent-org#12`). The first tracker's claims make exactly the calls they made before. a11ign/a11ign#4737, agent-org#575.
