---
"agent-org": minor
---

Worker and planner briefs carry their repository's lessons, and the board has a Lessons page to edit or delete them (A11-432, step 2 of 3). While `tickets.lessons` is on, each worker and planner brief (batch planning included) gets a "Lessons from earlier runs" section with the lessons of the run's repository, each naming the runs it came from, read from `<stateDir>/tickets/lessons/<repo>.json` as the run starts. With it off, the default, briefs are unchanged. The new Lessons page (`/lessons`, in the sidebar after Outcomes) lists every repository's lessons and lets a person edit a lesson's text or delete it, through `GET /api/lessons`, `POST /api/lessons/edit` and `POST /api/lessons/delete`; the next brief carries the edit, or no lesson. The daily retro now reads the lessons file again after its model answers, so an edit or delete made meanwhile is kept.
