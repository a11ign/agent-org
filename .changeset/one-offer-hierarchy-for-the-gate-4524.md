---
"agent-org": minor
---

The gate offers Ready rows in one declared order (a11ign/a11ign#4524): a `priority:chairman` row first, then `priority`, then the project's milestone ranking, then the oldest. A `priority:chairman` label counts only when the tracker's history shows a login in `CHAIRMAN_LOGINS` added it (any other actor's is ignored, said on stderr and reported to `ceo`), and its order carries `startFresh: true` for the spawner. `priority` now also overrides the product-share floor, which binds plain rows only. A chairman row is no longer shelved by B4 against a holder that is not itself a chairman row: it is offered and the holder is told to rebase; a chairman row that is refused is reported to `ceo` with the reason. A project ranks milestones with the optional `offerMilestones` list in `.agent-org/project.json` (a milestone number or title, primary first); absent, rows are ordered as before. The Ready-row read now asks for `milestone`.
