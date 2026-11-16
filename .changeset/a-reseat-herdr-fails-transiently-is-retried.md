---
"agent-org": patch
---

A run the board starts again because its pane lost its environment no longer waits for a person when herdr fails the new start transiently (A11-436). The board closes the old workspace first, so a herdr that then never answered left the run crashed with no retry. The run now gets the board's own crash retry, as a failed first start does ("trying again 1 of 2 in 30 s"). A failure that is not transient still waits for a person.
