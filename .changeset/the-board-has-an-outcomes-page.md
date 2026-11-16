---
"agent-org": minor
---

The board has an Outcomes page, `/outcomes`, linked from the sidebar under Runs (A11-430, step 3 of 3). It shows what a week's runs cost and how they went, read from `/api/outcomes`: by model and effort, by repository and by label, each group's runs, cost, the reviewer's share, rounds per pull request, first-pass approval rate and Needs-you rate. Every figure is a button that lists the runs behind it under the tables, each linking to its run's page. Every dollar figure says it is at configured prices, and a floor (unpriced or unread tokens) reads "≥". Previous week and Next week step the window through `?from=&to=`. An outcome log the instance cannot read is its sentence in the error banner, never an empty week.
