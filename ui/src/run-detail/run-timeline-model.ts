// module: what a run's Timeline says -- one row for each thing that happened to the run, newest first, as the Run detail boards draw it (A11-202)
//
// THE EVENTS ARE THE BACKEND'S (`runTimeline` in `board-view/run-timeline.ts`: the log the board recorded, or what the run's own times rebuild). The boards' lines are illustrations of the wording ("Started", "Run finished",
// "Approved at 1f6009d"), so each kind of event is worded here in their voice, from the event's own fields and never from a board's example. A reason is the backend's own first line.
import { baseMergeWords } from "../../../src/ticket-mode/board-view/base-merge-words.ts";
import { pullLabel } from "../../../src/ticket-mode/board-view/pull-label.ts";
import { runTimeline, type TimelineEvent } from "../../../src/ticket-mode/board-view/run-timeline.ts";
import type { AnsweredBy, BaseMergeStep, RequeueWhy, RoundCause, RunEvent } from "../../../src/ticket-mode/queue/run-log.ts";
import { length, NOTE_JOIN, since, type RunEntry } from "../runs/runs-model.ts";

/** The colour of a row's dot, as the boards give them: amber for what is under way or waits on a person, green for an approval, violet for a pull request and a publish, red for a failure, grey for the rest. */
export type DotTone = "amber" | "green" | "violet" | "red" | "grey";

/** One row of the Timeline: what happened, when and with what, and its dot. */
export type TimelineRow = Readonly<{ text: string; when: string; tone: DotTone }>;

const SHORT_HEAD = 7;

/** The cause of a round, in words: why the run was started again on its pull request. */
const ROUND_WORDS: Readonly<Record<RoundCause, string>> = {
  feedback: "Feedback round", checks: "Fixing red checks", conflict: "Resolving a conflict", asked: "Answering a question", decisions: "Meeting a change of the ticket's Decisions", approved: "Working on the approved drafts", talk: "Talk session", rereview: "Second look at a blocked head", "ci-budget": "Held for its CI spend", "standoff-planner": "Planner deciding a stand-off", "standoff-worker": "Answering a stand-off",
};

/** What the board did with a stand-off (A11-290), in words. */
const STANDOFF_WORDS: Readonly<Record<"planner" | "worker" | "decided" | "settled", string>> = { planner: "Stand-off sent to the planner", worker: "Stand-off sent to the worker", decided: "Planner decided the stand-off", settled: "Stand-off settled with no person" };

const ANSWER_WORDS: Readonly<Record<AnsweredBy, string>> = { respond: "Respond", approve: "approval", talk: "Talk to it", answer: "the board's answer", terminal: "the run's own terminal" };

const REQUEUE_WORDS: Readonly<Record<RequeueWhy, string>> = { retry: "a retry", "next-step": "the next plan step", update: "an update", replan: "the plan written again", blocker: "a wait on another ticket", "ci-budget": "its CI budget", "conflict-round": "after its conflict round", restart: "a restart before its agent opened" };

/** The colour of a base-merge row: violet while the board merges the base in, as a pull request opened, and amber for a round, a wait or the cap, as a round is. */
const BASE_MERGE_TONES: Readonly<Record<BaseMergeStep, DotTone>> = { merging: "violet", behind: "violet", round: "amber", waiting: "amber", capped: "amber", held: "amber" };

/** How long ago an event was: "just now" inside the first minute, then "5 min ago". */
const agoOf = (at: number, now: number): string => (now - at < 60_000 ? "just now" : `${since(at, now)} ago`);

const joined = (...parts: readonly (string | null)[]): string => parts.filter((part): part is string => part !== null && part !== "").join(NOTE_JOIN);

/** The model and effort a run was given, "sonnet/high", and after a comma how its plan was made ("plan first", "unattended plan"), as the boards' Queued and Started rows say it. */
function choiceOf(model: string, effort: string, plan: string | null): string | null {
  if (model === "") return plan;
  const choice = effort === "" ? model : `${model}/${effort}`;
  return plan === null ? choice : `${choice}, ${plan}`;
}

/** A run that ended other than well: the outcome kinds the board draws as Failed. */
const FAILED_OUTCOMES: ReadonlySet<string> = new Set(["crashed", "failed"]);

/** What a row is worded against: the time now, when the run began (which a finish counts its length from), whether the event is the run's newest, and whether the run is still going. `canceled` is the tracker's word on the ticket, which ends the run. */
type Context = Readonly<{ now: number; startedAt: number | undefined; newest: boolean; going: boolean; canceled: boolean; planned: boolean }>;

/** The row of one event. */
function rowOf(event: TimelineEvent, { now, startedAt, newest, going, canceled, planned }: Context): TimelineRow {
  const ago = agoOf(event.at, now);
  const note = event.rebuilt === true ? "from the run's times" : null;
  switch (event.kind) {
    case "queued": return { text: "Queued", when: joined(ago, choiceOf(event.model, event.effort, event.planFirst ? "plan first" : null), note), tone: "grey" };
    case "planned": return { text: "Plan written", when: joined(ago, note), tone: "grey" };
    case "started": return { text: "Started", when: joined(ago, choiceOf(event.model, event.effort, planned ? "unattended plan" : null), note), tone: newest && going ? "amber" : "grey" };
    case "round": return { text: ROUND_WORDS[event.cause], when: joined(ago, event.reason, note), tone: "amber" };
    case "pr-opened": return { text: "Pull request opened", when: joined(pullLabel(event.url), ago, note), tone: "violet" };
    case "verdict": return event.review === "approved"
      ? { text: `Approved at ${event.head.slice(0, SHORT_HEAD)}`, when: joined(pullLabel(event.url), ago), tone: "green" }
      : { text: `Changes requested at ${event.head.slice(0, SHORT_HEAD)}`, when: joined(pullLabel(event.url), ago), tone: "amber" };
    case "rereview": return { text: event.verdict === "not-convinced" ? "rereview: still not convinced" : "rereview: convinced, but the door refused it", when: joined(pullLabel(event.url), `at ${event.head.slice(0, SHORT_HEAD)}`, ago), tone: "amber" };
    case "standoff": return { text: STANDOFF_WORDS[event.step], when: joined(pullLabel(event.url), event.detail, ago), tone: event.step === "settled" ? "green" : "amber" };
    case "needs-you": return { text: "Waiting on a person", when: ago, tone: "amber" };
    case "answered": return { text: "Answered", when: joined(ago, ANSWER_WORDS[event.by]), tone: "grey" };
    case "published": return { text: "Published", when: joined(ago, note), tone: "violet" };
    case "base-merge": return { text: baseMergeWords(event.url, event.base, event.step), when: joined(ago, note), tone: BASE_MERGE_TONES[event.step] };
    case "merged": return { text: "Pull request merged", when: joined(pullLabel(event.url), ago, note), tone: "violet" };
    case "finished": return newest && canceled ? { text: "Ticket canceled in the tracker", when: joined(ago, note), tone: "grey" } : event.outcome === "needs-human" ? { text: "Handed back to a person", when: joined(ago, note), tone: "amber" } : {
      text: FAILED_OUTCOMES.has(event.outcome) ? "Run failed" : "Run finished",
      when: joined(startedAt === undefined ? ago : `after ${length(event.at - startedAt)}`, note),
      tone: FAILED_OUTCOMES.has(event.outcome) ? "red" : "grey",
    };
    case "dismissed": return { text: "Dismissed", when: ago, tone: "grey" };
    case "removed": return { text: "Removed", when: ago, tone: "grey" };
    case "requeued": return { text: "Queued again", when: joined(ago, REQUEUE_WORDS[event.why]), tone: "grey" };
  }
}

/**
 * The Timeline of a run, from its `log` (the run's full read sends it, A11-270): the events `runTimeline` gives, newest first, each as a row. A run still going has its newest event, when that is "Started", in amber, as the running board draws it; once anything else has happened it is grey. The ticket the tracker canceled ends the run's newest finish in the words of the Cancelled board, and a run that ended asking a person is "Handed back to a person", as the Handed back board says it. A run with no event
 * (a log that was never recorded and times that rebuild nothing) has no Timeline. PURE.
 */
export function timelineOf(entry: RunEntry, log: readonly RunEvent[], now: number): readonly TimelineRow[] {
  const events = runTimeline(entry, log);
  const startedAt = events.find((event) => event.kind === "started")?.at ?? entry.startedAt;
  const canceled = entry.trackerState === "canceled" || entry.trackerState === "duplicate";
  return events.map((event, index) => rowOf(event, { now, startedAt, newest: index === events.length - 1, going: entry.phase !== "finished", canceled, planned: entry.planned === true })).reverse();
}
