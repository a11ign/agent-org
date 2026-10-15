---
"agent-org": patch
---

A probe of a seat that has ended no longer writes herdr's `agent_not_found` / `pane_not_found` to the work tick's journal. The herdr runner in `src/herdr-agents.ts` now captures stderr and re-emits it only when it is a refusal other than "gone"; the three spawn sites in `src/wake.ts`, `src/herdr-agents.ts` and `src/work-gate/reads.ts` go through it, so every ended seat stopped writing once per probe per tick (agent-org#1487). A refusal that is not "gone" still reaches the journal, and a "gone" answer still rides on the thrown error for the callers that read it.
