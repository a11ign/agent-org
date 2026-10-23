---
"agent-org": patch
---

Ticket mode answers a Claude Code safety prompt on an unattended run instead of leaving it waiting for a person (A11-174). When a running agent sits on a permission or confirmation prompt (a dialog that asks `Do you want to ...` and offers `No ... (esc)`, such as the "Dangerous rm operation on possibly-empty variable path" prompt), the pool presses Esc, which is the prompt's No and never Yes, then tells the agent in one message which command was refused and why: for the empty-variable warning, to guard variable paths with `${VAR:?}`. The card says "A safety prompt was declined automatically: <command>" in place of "Waiting on a person". A run gets three declines; a fourth prompt, any dialog the pool does not recognise, and a talk session are left for a person, and the card says "Waiting on a person: <first line of the dialog>". Every unattended brief (plan, batch plan, worker, review, publish and writer) now carries the rule to guard variable paths.
