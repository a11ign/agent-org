---
"agent-org": patch
---

The flag-without-a-switch check reported `UNKNOWN -- the open ready rows of a11ign/agent-org could not be read` on every tick and never said why. The read's error was discarded, so the line could only say that the read failed. The owed-rows read now keeps the first line of the thrown error, and the `unknown` names it, so the tick's line says what refused the read (a11ign/agent-org#1700).
