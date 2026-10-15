---
"agent-org": patch
---

A `herdr` probe of an ended seat no longer writes to the work tick's journal from every caller. Each `execFileSync("herdr", …)` outside the shared runner (`src/worker-state.ts`, `src/prompt-session.ts`, `src/host-units.ts`, `src/crash-recover.ts`, `src/fleet-gated-nightly.ts`, `src/ticket-mode/pool.ts`) inherited the tick's stderr, so each `agent_not_found` / `pane_not_found` answer for a seat that had ended was printed once per probe per tick. They now go through `herdrRun` in `src/herdr-agents.ts`, which captures stderr and re-emits only a refusal other than "gone". A caller that catches a "gone" answer reads the seat as gone, a caller that lets it escape still gets it thrown, and a refusal such as `agent_blocked` still reaches the journal. agent-org#1462.
