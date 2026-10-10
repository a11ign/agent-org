---
"agent-org": patch
---

The board audit no longer calls two class-repeat rows for different failure classes near-duplicates. The work gate files every class's row from one title, `Failure class <id> repeated: make its guard stop it everywhere`, so a11ign#4833 (`main-red`) and #4623 (`hand-reroute`) share 10 of 12 words (0.83 against `DUPLICATE_SIMILARITY` 0.8) and `board-disagrees-with-reality` tripped on #4833. `nearDuplicates` now refuses a pair for which `namesDifferentFailureClasses` is true, beside `namesDifferentRepos` (#4137): both titles carry a `Failure class <id> repeated` id, compared lower-cased, and the ids differ. Two rows for the same class id, and a title not of that form, are compared by words alone as before; the repository rule, the thresholds and the `Superseded by` reading are unchanged. a11ign/agent-org#671.
