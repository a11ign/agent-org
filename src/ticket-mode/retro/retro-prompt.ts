// @ts-check
// module: what the ticket-mode retro asks its model, and how its answer is read (A11-432)
//
// THE MODEL CLUSTERS, THE CODE CHECKS. The model is given one repository's items and its lessons so far, and answers with lessons in JSON. Its answer is never trusted as written:
// a run it cites must be one of the items' runs, a new lesson must cite at least {@link RECURRING_MIN} of them (a lesson is a cause that RECURS, not one run's mistake), and a lesson that
// re-confirms an old one must name that lesson's id and cite at least one run. Whatever fails a check is dropped, so a lesson on the board always names runs that happened.
import type { RetroItem } from "./evidence.ts";
import type { Lesson, Proposal } from "./lessons-store.ts";

/** The fewest runs a new lesson cites. */
export const RECURRING_MIN = 2;

/** The longest a lesson's text is kept. */
const LESSON_TEXT_MAX = 300;

/** The prompt for `repo`'s retro: the instruction, its lessons so far and the items, one per line. PURE. */
export function retroPrompt(repo: string, lessons: readonly Lesson[], items: readonly RetroItem[]): string {
  const known = lessons.length === 0 ? "(none yet)" : lessons.map((lesson) => `- ${lesson.id}: ${lesson.text}`).join("\n");
  const read = items.map((item) => `- [${item.run}] (${item.source}) ${item.text}`).join("\n");
  return [
    `You are the daily retrospective of the ticket-mode workers of the repository ${repo}.`,
    "Below are what went wrong in their recent runs: reviewer findings, rounds started by red checks, cap and stand-off events, and the reasons runs were handed to a person. Each line names its run in brackets.",
    `Find the causes that RECUR: the same kind of mistake in at least ${RECURRING_MIN} different runs. For each, write one lesson: a short instruction a worker in ${repo} should follow, in one plain sentence. Ignore a one-off.`,
    "When a cause is one of the existing lessons, re-confirm it by giving that lesson's id instead of writing a new one.",
    "",
    `Answer with JSON only, no prose: {"lessons": [{"id": "<existing id, or omit for a new lesson>", "text": "<the lesson>", "runs": ["<run>", ...]}]}. List only the runs whose lines show the cause.`,
    "",
    "Existing lessons:",
    known,
    "",
    "What went wrong:",
    read,
  ].join("\n");
}

/** The JSON object in a model's reply: the reply itself, or the first `{` to the last `}` when it wrapped it in a code fence or a sentence. Null when there is none. PURE. */
function objectIn(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Whether `result` is a headless run's result that answered with text, not an error. PURE. */
function isAnswer(result: { result?: unknown; is_error?: unknown } | null): result is { result: string } {
  if (result === null || typeof result !== "object") return false;
  return typeof result.result === "string" && result.is_error !== true;
}

/** The text the headless `claude -p --output-format json` run answered: its result's `result`. Null when stdout is not such a result. PURE. */
export function replyOf(stdout: string): string | null {
  try {
    const result = JSON.parse(stdout.trim().split("\n").pop() ?? "") as { result?: unknown; is_error?: unknown } | null;
    return isAnswer(result) ? result.result : null;
  } catch {
    return null;
  }
}

/**
 * The proposals in the model's `reply`, each checked against the runs it could cite (`runs`) and the ids of `lessons`: unknown runs are dropped from it, and it is dropped when it is left with
 * too few (one for a re-confirmation, {@link RECURRING_MIN} for a new lesson) or has no text. Null when the reply holds no `lessons` list: an answer that cannot be read changes nothing. PURE.
 */
export function proposalsOf(reply: string, runs: ReadonlySet<string>, lessons: readonly Lesson[]): Proposal[] | null {
  const answer = objectIn(reply) as { lessons?: unknown } | null;
  if (answer === null || typeof answer !== "object" || !Array.isArray(answer.lessons)) return null;
  const ids = new Set(lessons.map((lesson) => lesson.id));
  return (answer.lessons as unknown[]).map((raw) => proposalOf(raw, runs, ids)).filter((proposal): proposal is Proposal => proposal !== null);
}

/** One entry of the model's `lessons`, checked: its known runs, its id when it names an existing lesson, its text on one line; null when it is left with too few runs or no text. PURE. */
function proposalOf(raw: unknown, runs: ReadonlySet<string>, ids: ReadonlySet<string>): Proposal | null {
  if (raw === null || typeof raw !== "object") return null;
  const { id, text, runs: cited } = raw as { id?: unknown; text?: unknown; runs?: unknown };
  const known = typeof id === "string" && ids.has(id) ? id : undefined;
  const valid = Array.isArray(cited) ? [...new Set(cited.filter((run): run is string => typeof run === "string" && runs.has(run)))] : [];
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, LESSON_TEXT_MAX) : "";
  if (known !== undefined) return valid.length >= 1 ? { id: known, text: line, runs: valid } : null;
  return valid.length >= RECURRING_MIN && line !== "" ? { text: line, runs: valid } : null;
}
