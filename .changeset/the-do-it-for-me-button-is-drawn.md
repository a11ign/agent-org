---
"agent-org": minor
---

The "Do it for me" button is drawn (a11ign/a11ign#3982, the gap under #3431 Done-when 3). `answers.mjs` handled a `forme` press and no keyboard carried one, so no brief could ask for it. A brief that NAMES the act it would do, in one line `Do it for me: <the act>` (read by `parseChairmanAct`, `sources/requests.mjs`, as the other brief lines are), now draws a fourth button after Later, and the alert shows the same line so the chairman's OK is for an act he read. A brief that names no act draws none, as before, because a press would then OK an unnamed act (D1, a11ign/a11ign#3427). All or nothing, as the options are: the button counts against the keyboard's room, so a request whose options leave none for it carries no keyboard rather than one missing it. A procedure brief's keyboard is unchanged, and `doItForMe` is untouched.
