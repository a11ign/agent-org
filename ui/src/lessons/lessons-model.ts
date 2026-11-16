// module: what the Lessons page (A11-432) shows of the instance's answer -- the count, a cited run's ticket and its link, and the words for whether briefs carry the lessons. PURE.
import type { LessonsView } from "../../../src/ticket-mode/retro/lessons-route.ts";
import { runHref } from "../shell/routes.ts";

/** The heading's count: every lesson of every repository. */
export function countText({ repos }: LessonsView): string {
  const count = repos.reduce((sum, { lessons }) => sum + lessons.length, 0);
  return `${count} ${count === 1 ? "lesson" : "lessons"}`;
}

/** Whether the answer has nothing to show: no lessons, and no file it could not read. */
export const isEmptyLessons = ({ repos, unreadable }: LessonsView): boolean => unreadable.length === 0 && repos.every(({ lessons }) => lessons.length === 0);

/** The ticket of a cited run, `<ticket>@<first start>` (the outcome record's `run`), or the whole id when it names none. */
export const ticketOfRun = (run: string): string => (run.includes("@") ? run.slice(0, run.lastIndexOf("@")) : run);

/** A cited run's link: its ticket's run page, which shows the ticket's latest run. */
export const runLink = (run: string): string => runHref(ticketOfRun(run));

/** The day a lesson was last confirmed, as `YYYY-MM-DD` in UTC, the day the retro runs by. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The line under the heading while `tickets.lessons` is on: worker and planner briefs carry these lessons. */
export const CARRIED = "Worker and planner briefs carry these lessons: tickets.lessons is on. An edit or a delete is in the next brief.";

/** The line under the heading while `tickets.lessons` is off: no brief carries them yet. */
export const NOT_CARRIED = "tickets.lessons is off, so no brief carries these lessons yet. You can still check, edit or delete what the retro wrote.";

/** The line under the heading for an answer: whether worker and planner briefs carry its lessons now. */
export const carriedText = ({ on }: Pick<LessonsView, "on">): string => (on ? CARRIED : NOT_CARRIED);
