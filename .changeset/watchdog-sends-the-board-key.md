---
"agent-org": patch
---

The watchdog asks `/api/health` with the board's key, and never restarts an instance that answers 401 or 403 (A11-377). Before, it sent no key, so the route refused it, and the watchdog counted the refusal as no answer. From 14:22 on 2026-10-28 it restarted the board every four minutes, 64 times. Each restart re-ran the start-up checks and the doctor, which was most of the "held the loop" lines. The held-loop line now also names the caller of a code-host `gh`, not `call-counter.ts`.
