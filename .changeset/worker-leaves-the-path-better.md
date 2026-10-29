---
"agent-org": patch
---

The worker, review-round and planner briefs now quote one scope rule (`brief-scope.ts`). A ticket's outcome beats its out-of-scope list: a run that finds the list in the way of the outcome treats that code as in scope. A problem found on the path of the change is fixed in the same pull request when it is in the same package, or named under `## Found on the path` in the body, never only as a decision made without a person. A cost moved to another step of the journey, such as from page load to the first click, does not meet the outcome. A ticket about speed or load traces the requests from opening the view through its first interaction before anything changes. A live check counts only if it could have failed on the base, and data that cannot show the behaviour is added or stubbed, or the behaviour is reported unchecked.
