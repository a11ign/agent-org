---
"agent-org": patch
---

`row-claim claim` makes its four `gh label create --force` together instead of one after another. They create-or-update each label to the same colour and description every time, so none depends on another; on one real claim tick they were 3,168 ms of the claim's 15,662 ms, and the same four measured 3.3 to 3.7 s one at a time and 0.9 to 1.6 s together. The commands are unchanged, they still run before the fresh label read, the label `PUT` and the re-read after it stay one at a time and in order, and a create GitHub refuses (or a batch that cannot start) is said aloud and then asked one at a time, which throws the error the claim always threw before any label of the row is written. a11ign/a11ign#3566, slice 9 of the tick's cost.
