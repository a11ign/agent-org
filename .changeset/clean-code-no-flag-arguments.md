---
"agent-org": patch
---

Production code no longer takes a boolean parameter that selects between two behaviours: each such function is now two named functions, or takes the fact its boolean carried as a named property. `clean-code/no-flag-arguments` is an error in `npm run lint`. Behaviour is unchanged.
