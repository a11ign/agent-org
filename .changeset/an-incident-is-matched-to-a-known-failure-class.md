---
"agent-org": minor
---

`matchFailureClass(incident, index, deps)` (`src/class-match.ts`, via `classifyIncident` in `class-repeat.ts`) asks which known failure class an incident belongs to, as a `choice` through `decide` (use `failure-class-match`), so a defect nobody labelled to a class is still counted (a11ign/a11ign#4437). The provider sees only the incident's `kind`, title and the first line of its cause, and each class's `id`, `name` and `guard`; with more than 12 classes it is asked guard first, then id. The deterministic fallback is an exact match of `kind` on a class's `id` or its new optional `kinds` list in `failure-classes.json`; a confidence under the floor, a refusal, no provider, no key or the use switched off all take it, and an incident it cannot place is `none-of-these` and gets no label. `recordLabelOutcome` appends whether a human kept or removed the label to the decision log. a11ign/a11ign#4633.
