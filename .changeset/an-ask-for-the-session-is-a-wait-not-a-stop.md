---
"agent-org": minor
---

An ask that only the person's session can do (running a command on the person's machine, reading the board, a live check against a release) no longer reaches Needs you (A11-275). A worker declares it as a `session` wait, `{ "session": "<the exact command, where it runs, and what a pass looks like>" }` in a `working` outcome's `waitingOn`, and ends its turn: the run stays In progress, waiting. The board lists the ask in the session's queue, `GET /api/session-asks`, as `kind: "waiting-run"` beside the After-merge checks, and the session answers it with `POST /api/session-asks/<KEY>/answer` and `{ "ask", "result" }`. The result is kept in `session-answers.json` in the board's tickets directory, finishes the wait, and is in the prompt that wakes the worker. The briefs, the stop hook's refusal and the shipped house notes tell a worker to use it instead of `needs-human`.
