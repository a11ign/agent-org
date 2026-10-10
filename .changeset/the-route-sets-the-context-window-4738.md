---
"agent-org": minor
---

The engineer route sets the context window as well as the model and effort (a11ign/a11ign#4738, #4627 use 1b). `routeEngineer` sizes the `--autocompact` window from the Region alone: 200k under 8 files and one repository, 400k from 8 files or two repositories, 600k from 16 files or three, and a Haiku route stays at its ceiling (`clampWindow`). With the provider, the `score` and `subsystems` answers move it one rung, only when each was given at or over the confidence floor and `"model-routing-window": true` is set in `.agent-org/decisions.json`; an answer not given leaves the Region's window and the line says so. The outcome line reads `route sonnet/high window 400k (<basis>) via jev (<why>)`, and `node src/engineer-route.ts [--record]` prints window against compactions, cost and outcome per route from the decision log and the trace store, recording `window too small` for a row that compacted more than twice.
