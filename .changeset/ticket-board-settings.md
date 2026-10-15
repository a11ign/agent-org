---
"@a11ign/agent-org": minor
---

The ticket board has a Settings panel, opened from its header, for the choices that stand between runs: the model and the effort a ticket queued from now on runs with, and how many workers run at once. Each change is saved as it is made, and one the board refuses goes back to what is saved, with the reason shown in the panel. The Pick tab's footer names the model and effort Queue will use, and the Board names how many workers run at once, each with a link to change it. The model and effort are saved through a new `POST /api/choice`, which changes only the part it names, so two pages open at once cannot undo each other. Queueing no longer saves them. A saved model or effort the board no longer offers falls back to the default. The footer no longer hides under a section header that scrolls beneath it.
