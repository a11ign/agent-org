// module: the buttons of a run's row -- exactly the verbs `runActions` returns, in its order, each with its accessible name and its tooltip
//
// THE VERBS ARE board-view's. The Runs board draws the icons and names of Talk to it, Stop and Dismiss; every other verb keeps the label and title `ui.html` gives it. "Send back for changes" and "Comment", which the board draws
// on a Ready to merge row, are not verbs `runActions` returns and are not drawn.
import { APPLY_EDIT_TITLE, APPROVE_TITLE, DISCARD_EDIT_TITLE, DISMISS_EDIT_TITLE, DISMISS_TITLE, hasEdit, RESPOND_TITLE, runActions, START_ANYWAY_TITLE } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import type { QueueView, RunAction } from "../api/types.ts";
import type { RunEntry } from "./runs-model.ts";

/** What the board calls Talk to it: its name, and the title it gives the button. */
export const TALK_NAME = "Talk to it";
export const TALK_TITLE = "Talk to it: opens this run's session in herdr";

/** The accessible name of each verb's button: the board's for Talk to it, Stop and Dismiss, `ui.html`'s for the rest. */
export const ACTION_NAME: Readonly<Record<RunAction, string>> = {
  talk: TALK_NAME, stop: "Stop run", dismiss: "Dismiss from list",
  remove: "Remove", retry: "Retry", close: "Close", approve: "Approve", respond: "Respond to review", "start-anyway": "Start anyway", "apply-edit": "Apply edit", "discard-edit": "Discard edit",
};

const TITLES: Partial<Record<RunAction, string>> = {
  talk: TALK_TITLE, approve: APPROVE_TITLE, respond: RESPOND_TITLE, "start-anyway": START_ANYWAY_TITLE, dismiss: DISMISS_TITLE, "apply-edit": APPLY_EDIT_TITLE, "discard-edit": DISCARD_EDIT_TITLE,
};

/** One button of a row. */
export type RowAction = Readonly<{ verb: RunAction; name: string; title: string }>;

/** The tooltip of a verb: its title, Dismiss's saying the proposal goes with the run when there is one, else its name. */
function titleOf(verb: RunAction, entry: RunEntry): string {
  if (verb === "dismiss" && hasEdit(entry)) return DISMISS_EDIT_TITLE;
  return TITLES[verb] ?? ACTION_NAME[verb];
}

/** The buttons of a run: the verbs `runActions` returns for it, in its order. PURE. */
export const actionsOf = (entry: RunEntry, queue: QueueView): RowAction[] =>
  runActions(entry, queue.publish, queue.entries).map((verb) => ({ verb, name: ACTION_NAME[verb], title: titleOf(verb, entry) }));
