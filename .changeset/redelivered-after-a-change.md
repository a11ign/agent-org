---
"agent-org": patch
---

`trace --aggregate`'s by-cause table splits each cause's re-delivered repeats into **after a change**, **unchanged** and **unexplained**, with the repeats and dollars of each and a closing row for the class, so the dollars of an order re-sent are visible apart from a row worked a second time (`ready-row-unclaimed` repeats are mostly a spawn that did work). A change is read from the store's GitHub record and never guessed: between the previous delivery of the key and the repeat, a `claimed`, `released`, `labeled` or `unlabeled` event on the row or pull request THE KEY names, or, for a key that carries a head sha, a `head_moved` to a different head. A repeat with no such record is `unchanged`; one whose subject has no GitHub event in the store at all (or whose key names none) is `unexplained` and in neither column. The re-delivered line keeps its definition and its total. a11ign/a11ign#3661, from #3626.
