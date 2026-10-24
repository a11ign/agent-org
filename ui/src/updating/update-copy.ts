// module: the words and step states of the Updating, Slow and Back screens (PURE) -- the boards' copy, with the board's sample versions replaced by the real ones
//
// THE BOARDS ARE `AtomautUpdating`, `AtomautUpdatingBreaking`, `AtomautUpdatingSlow` and `AtomautUpdatingBack`: one card whose title, subtitle, three steps and runs note change with the stage and the release.
// The three steps are a simplified story, not progress from the updater: the first is done, the second is under way and the third is next, and all are done on Back.
import { shortVersion } from "../../../src/ticket-mode/board-view/update-banner.ts";
import type { UpdateView } from "./update-model.ts";

export type StepState = "done" | "now" | "next";
export type Step = Readonly<{ text: string; state: StepState }>;

/** What the card says. `slowNote` is shown on Slow only, and `backLink` on Back only. */
export type Screen = Readonly<{ title: string; sub: string; steps: readonly Step[]; runsNote: string; working: boolean; slowNote: boolean; backLink: boolean }>;

const normalNote = (to: string): string => `Runs already working keep going. Each stays on the version it started on, and new runs start on ${to}.`;
const breakingNote = (to: string): string => `This is a breaking release, so it waited for live runs to finish and started no new ones. Any run stopped at the deadline is queued again and resumes on ${to}.`;
const breakingBackNote = (to: string): string => `This was a breaking release, so no new runs started while it waited. Runs that were stopped at the deadline are queued again and resume on ${to}.`;

/** The sentence under the steps: what happens to the runs, which depends on the release, and on whether the board is back. */
function runsNoteOf(view: Exclude<UpdateView, Readonly<{ kind: "none" }>>, to: string): string {
  if (view.release === "normal") return normalNote(to);
  return view.kind === "back" ? breakingBackNote(to) : breakingNote(to);
}

const STEP_TEXT = ["Restarting the board", "Reconnecting this page"] as const;

/** The card for a screen that is not `none`. PURE. */
export function screenOf(view: Exclude<UpdateView, Readonly<{ kind: "none" }>>): Screen {
  const to = shortVersion(view.to);
  const back = view.kind === "back";
  const [restarting, reconnecting] = STEP_TEXT;
  const steps: readonly Step[] = [
    { text: `New version ${to} is ready`, state: "done" },
    { text: restarting, state: back ? "done" : "now" },
    { text: reconnecting, state: back ? "done" : "next" },
  ];
  const slow = view.kind === "updating" && view.slow;
  return {
    title: back ? `Updated to ${to}` : slow ? "Still updating" : "Updating Atomaut",
    sub: view.kind === "back" ? "The board is back on the new version." : `Moving this instance from ${shortVersion(view.from)} to ${to}. This page reconnects by itself.`,
    steps, runsNote: runsNoteOf(view, to), working: !back, slowNote: slow, backLink: back,
  };
}
