---
"agent-org": patch
---

`src/route-outcome.ts` is the writer of a routed row's outcome (a11ign/a11ign#4627 use 4, agent-org#687): `routeOutcomeOf` names it from a fixed vocabulary (`merged-first-pass`, `not-first-pass`, `escalated`, `closed-without-merge`), taking first pass from `trace/haiku-tier-report.ts`'s own definition, and `recordClosedRow` appends it through `recordRouteOutcome` once per row, and only for a row the decision log routed with the `model-routing` use on. Nothing calls `recordClosedRow` yet: the close paths in this package run on a GitHub-hosted runner that cannot read the host's decision log, so the caller is a host-side one, named on agent-org#687.
