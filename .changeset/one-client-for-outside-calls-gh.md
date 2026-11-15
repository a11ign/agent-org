---
"agent-org": patch
---

The board's `gh` calls now go through the one client for outside services (A11-436 step 2 of 3). The code host plugin is handed the client as `deps.outside`, bound to GitHub, and the runner the board's loop reads and writes GitHub through (`asyncGhRunner`) makes each `gh` through it: a read that met a connection reset, a timeout or a 5xx is tried again, a write is made once so it is never repeated, one GitHub answered (a 404, `gh pr checks` while checks are pending) is not, ten failed attempts in a row open GitHub's breaker so the next call is refused at once with "GitHub is unavailable", and the call counts once in `/api/health`'s GitHub figure. Which `gh` failures are transient is now read in one place, `programKindOf` in `src/ticket-mode/outside-client.ts`, which also classes a thrown `GhFailure` for the crash retry and counts the `gh` calls the client does not make (row mode's synchronous ones). herdr moves onto the client in step 3.
