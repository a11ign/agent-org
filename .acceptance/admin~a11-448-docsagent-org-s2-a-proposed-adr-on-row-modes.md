Adds ADR 0019 with status Proposed (A11-448, idea S2 of A11-429). It proposes retiring row mode: retro, cost tracing and account limits move into ticket mode (M3, M1, R2); anything that talks to an outside system goes behind a plugin contract, as Linear does; and the rest is deleted in eight follow-up tickets, in order. It sets out both options (move then delete, or freeze), the recommendation, the evidence, and the modules to move or delete. No module is deleted in this pull request.

Acceptance:
```bash
grep -q '^Status: Proposed' docs/adr/0019-row-mode-is-retired-its-useful-parts-move-into-ticket-mode-and-plugins.md
grep -q '^- \*\*A\. Move the useful parts, then delete the rest (recommended)\.\*\*' docs/adr/0019-row-mode-is-retired-its-useful-parts-move-into-ticket-mode-and-plugins.md
grep -q '^- \*\*B\. Freeze row mode\.\*\*' docs/adr/0019-row-mode-is-retired-its-useful-parts-move-into-ticket-mode-and-plugins.md
grep -q '^## Evidence' docs/adr/0019-row-mode-is-retired-its-useful-parts-move-into-ticket-mode-and-plugins.md
grep -q '^## Modules to move or delete' docs/adr/0019-row-mode-is-retired-its-useful-parts-move-into-ticket-mode-and-plugins.md
test "$(ls docs/adr | grep -c '^0019-')" = 1
test -z "$(git diff --name-only --diff-filter=D origin/admin/a11-432-featticket-mode-m3-a-daily-retro-writes-per...HEAD)"
```

Each line exits 0. The last two show that 0019 is the only ADR with that number, and that the diff from the branch this pull request is stacked on deletes no file.
