// @ts-check
// module: what the briefs say of a ticket's scope -- the outcome is the job, a problem on its path is fixed or named, and a live check must be able to fail; kept in one place so every brief quotes the same words
//
// THE OUTCOME BEATS THE OUT-OF-SCOPE LIST. A ticket's "out of scope" names separate work. A run once left the slow request it was asked to remove on the first click of the page, because the ticket called that code out of scope,
// and noted it as a decision made without a person: the cost moved and the outcome was not met. A ticket's author writes its scope before anyone has traced the work, so a run that finds the list in the way of the outcome
// follows the outcome.

/** What a worker, and a review round, do with the ticket's scope and with a problem they find on the path of their change. */
export const SCOPE_RULE = `## Leave the code better than you found it

The ticket's outcome is the job. Its out-of-scope list names separate work, and never excuses a problem on the path to that outcome. If something the ticket calls out of scope stops the outcome being met, the outcome wins: treat it as in scope, list that choice under "Decisions made without a person", and say so at the top of the pull request body. The out-of-scope list is not the ticket's Decisions, and this never reaches past the escalation list: a change that falls on it still stops for a person.

When you find a problem on the path of your change, in the code the ticket's user journey runs through or in the files you change:

- Fix it in this pull request when the fix is in the same package, with a test that fails without it.
- Otherwise, name it under \`## Found on the path\` in the pull request body: what it is, where it is, and what it leaves open. A note under "Decisions made without a person" alone is not enough.

Never leave the code worse than you found it. A cost that moves to another step of the journey, such as from opening a page to its first click, has not been removed, and the outcome is not met.

For a ticket about speed or load, trace the journey before you change anything: the requests sent from opening the view through its first interaction, and the code that sends each one. The pull request body lists them, before and after.`;

/** What a worker, and a review round, accept as a live check: one that would have failed on the base. */
export const LIVE_CHECK_RULE = "## A live check must be able to fail\n\nA live check counts only if it could have failed. Run it on the base first, or name what it would have shown there. When the data you have cannot show the behaviour, such as a dataset with none of the records the change is about, add or stub that data until it can, or say in the pull request body that the behaviour is unchecked live. For a change to what a view requests, record the requests through its first interaction, not only its first load.";

/** What a planner does with scope: the plan settles the journey, and its out-of-scope list never cuts the path to the outcome. */
export const PLANNER_SCOPE_RULE = "The plan's out-of-scope list names only separate work. It never names code the ticket's outcome depends on: if the ticket's own out-of-scope list does, the outcome wins, and the plan says so under `## Decisions made without a person`. "
  + "For a ticket about speed or load, the plan lists the requests the view sends from opening through its first interaction, and the code that sends each one, before it decides what to change.";
