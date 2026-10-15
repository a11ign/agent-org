---
"@a11ign/agent-org": patch
---

A `priority:chairman` row of a KEYED tracker now takes the spawn slot ahead of plain rows, as a home row's does. `scopeTick` passed no offer hierarchy to `decide`, so a plain row with a lower number was offered first and the chairman's order carried no `startFresh`. The keyed scope's own tracker now reads its verified chairman rows (`readChairmanPriorityOfOffer`, inside the tracker's repository) and hands them to `decide` as `offerHierarchy`, as `main` does. The labeller still decides: a label added by a login outside `CHAIRMAN_LOGINS` does not make a row the chairman's, and a scope with no tracker is unchanged. a11ign/agent-org#1085.
