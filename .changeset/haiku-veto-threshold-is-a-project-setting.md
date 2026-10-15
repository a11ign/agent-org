---
"@a11ign/agent-org": minor
---

The Haiku veto threshold is a project setting, `routing.sonnetVetoMinP` (a11ign/a11ign#5208). It was a constant of 0.7; it is now read from the project declaration, and an absent key is still 0.7, so no project changes behaviour until it sets the key. The value must be from 0.5 to 0.99: anything else is refused at load, naming the field. The routing decision line names the threshold it used.
