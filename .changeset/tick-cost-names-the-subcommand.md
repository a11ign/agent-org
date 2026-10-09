---
"agent-org": patch
---

The `tick-cost` line names each `gh`, `git` and `herdr` call by its SUBCOMMAND (`src/lib/spawn-census.ts`, `src/work-tick.mjs`): a new `subcommands` object, keyed `gh pr list`, `gh api repos/a11ign/a11ign/issues/#/timeline`, `git rev-parse`, `herdr agent list`, each with `n` and `wallMs`, the ten slowest by wall and the rest summed into `other` so the total still adds up. A digits-only path segment is `#` and a query string is dropped, so an issue number does not make every call its own key. Until now the line said `gh` was 66 calls and 50 s per tick and could not say which of them, so the gate's `gh` reads could not be cut in the order of the profile. A record with no `sub` (a `node`, or one written before this) is left out, not counted under an empty name. a11ign/a11ign#3566.
