// @ts-check
// module: what the person's session answered to a run that waits on it (A11-275) -- `POST /api/session-asks/<KEY>/answer`, and the answers on disk
//
// A worker that needs something only the person's session can do declares a `session` wait (`wait-on/`) and ends its turn. The run is waiting, never Needs you. The board lists the ask in the session's queue
// (`GET /api/session-asks`, as `kind: "waiting-run"`); the session does it and answers here. The answer is kept in `session-answers.json` in the board's tickets directory, beside the After-merge checks, and the board's next
// read of the wait finds it (`wait-on/wait-read.ts`) and wakes the worker with the result. An answer belongs to ONE declaration: it names the working note's `at` it was given for, so a later declaration of the same words
// waits for its own answer.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Json } from "./local-http.ts";
import type { Entry, Queue, WorkingNote } from "./queue/queue-entries-and-outcomes.ts";

/** The file the answers are kept in: beside the queue, in the board's tickets directory. */
export const SESSION_ANSWERS_FILE = "session-answers.json";

/** The most characters of a result the board keeps (as an answer to a question is held to, `pool-answer.ts`). */
export const MAX_RESULT_CHARS = 4000;

/** Where `stateDir`'s board keeps what the session answered. */
export const sessionAnswersPath = (stateDir: string): string => join(stateDir, "tickets", SESSION_ANSWERS_FILE);

/** One answer: the run's ticket, the ask as it was listed, the `at` of the working note it was given for, what the session saw, and when the board recorded it. */
export type AnswerRecord = Readonly<{ key: string; ask: string; at: number; result: string; answeredAt: number }>;

/** What the file holds. */
export type AnswersFile = Readonly<{ answers: readonly AnswerRecord[] }>;

const isRecord = (value: unknown): value is AnswerRecord => {
  if (typeof value !== "object" || value === null) return false;
  const { key, ask, at, result, answeredAt } = value as Record<string, unknown>;
  return typeof key === "string" && typeof ask === "string" && typeof at === "number" && typeof result === "string" && typeof answeredAt === "number";
};

/** The answers on disk, or none when there is no file. A file that cannot be read THROWS: read as no answers, it would be written over, and every answer in it lost. */
export function loadAnswers(path: string): AnswersFile {
  if (!existsSync(path)) return { answers: [] };
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const answers = (parsed as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(answers) || !answers.every(isRecord)) throw new Error(`${path} is not a record of the session's answers`);
  return { answers };
}

/** Replace the file whole: write beside it, then rename over it. */
function saveAnswers(path: string, file: AnswersFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(next, path);
}

/** What the session answered to `ask`, as given for the declaration made at `at` by a run of any of `keys` (a batch's tickets share one), or null for none. PURE. */
export function resultOf(file: AnswersFile, keys: readonly string[], ask: string, at: number): string | null {
  return file.answers.find((answer) => keys.includes(answer.key) && answer.ask === ask && answer.at === at)?.result ?? null;
}

/** The seam a run's wait is read with: the result recorded for each ask of the declaration made at `at`, read from disk each time. It THROWS when the file cannot be read. */
export const sessionResultsFrom = (stateDir: string, keys: readonly string[], at: number): ((ask: string) => string | null) =>
  (ask) => resultOf(loadAnswers(sessionAnswersPath(stateDir)), keys, ask, at);

/** A run waiting on one ask of the session: the ticket, where it is, its pull requests, the ask, and when the worker declared it. */
export type WaitingRun = Readonly<{ key: string; url: string; pullRequests: readonly string[]; ask: string; at: number }>;

/** Whether a note is a wait still on: its worker has not been woken for it, it is not marked stalled, and the board reads it (a repeat is not read). */
const stillWaiting = (note: WorkingNote): boolean => note.woke === undefined && note.stalled !== true && note.repeat !== true;

const pullRequestsOf = (entry: Entry): string[] => (entry.review ?? (entry.outcome !== undefined && "prs" in entry.outcome ? entry.outcome.prs : [])).map(({ url }) => url);

/** The asks of the session that the queue's runs wait on, one for each ask of each run (a batch is one run, named by its first ticket), in the order declared. PURE. */
export function waitingRuns(queue: Queue): WaitingRun[] {
  const seen = new Set<string>();
  return queue.entries.flatMap((entry) => {
    const note = entry.working;
    const run = entry.batch ?? entry.ticket.key;
    if (note === undefined || !stillWaiting(note) || seen.has(run)) return [];
    seen.add(run);
    return (note.waits ?? []).flatMap((wait) => wait.kind === "session" ? [{ key: entry.ticket.key, url: entry.ticket.url, pullRequests: pullRequestsOf(entry), ask: wait.ask, at: note.at }] : []);
  });
}

/** The asks the session has not answered yet. PURE. */
export const unansweredRuns = (queue: Queue, file: AnswersFile): WaitingRun[] => waitingRuns(queue).filter((run) => resultOf(file, [run.key], run.ask, run.at) === null);

const ROUTE = /^\/api\/session-asks\/([A-Za-z0-9_-]+)\/answer$/;

/** What the route needs of the board: where its state is, its clock and its queue. */
export type SessionAnswersBoard = Readonly<{ stateDir: string; now: () => number; queue: () => Queue }>;

/** The answer a request names. A malformed one THROWS, which the board answers with 400 and the sentence. */
function answerOf(body: Json): { ask: string; result: string } {
  if (typeof body.ask !== "string" || body.ask.trim() === "") throw new Error("ask must be the ask, exactly as GET /api/session-asks listed it");
  if (typeof body.result !== "string" || body.result.trim() === "") throw new Error("result must be one line or more saying what the session saw");
  if (body.result.length > MAX_RESULT_CHARS) throw new Error(`result takes up to ${MAX_RESULT_CHARS} characters, you wrote ${body.result.length}`);
  return { ask: body.ask, result: body.result.trim() };
}

/** Whether a note declares a wait on exactly this ask. */
const declaresAsk = (note: WorkingNote | undefined, ask: string): note is WorkingNote => note?.waits?.some((wait) => wait.kind === "session" && wait.ask === ask) === true;

/**
 * `POST /api/session-asks/<KEY>/answer` with `{ ask, result }`: records what the session saw for the run `<KEY>` that waits on that ask. 404 when the board has no run `<KEY>`; 409 when the run is not waiting on exactly that ask
 * (it was never declared, or its wait has ended). The same answer again is accepted and changes nothing; a different result for an ask already answered is a 409. The key the request carries is checked before this is reached,
 * as for every route. Undefined when the request names another route. A file that cannot be read THROWS.
 */
export function sessionAnswerRoute(board: SessionAnswersBoard, method: string, path: string, body: Json): [number, unknown] | undefined {
  const named = ROUTE.exec(path);
  if (method !== "POST" || named === null) return undefined;
  const key = named[1];
  const { ask, result } = answerOf(body);
  const run = board.queue().entries.find((entry) => entry.ticket.key === key);
  if (run === undefined) return [404, { error: `the board has no run ${key}` }];
  const note = run.working;
  if (!declaresAsk(note, ask)) return [409, { error: `${key} is not waiting on that ask: send it exactly as GET /api/session-asks listed it` }];
  const file = sessionAnswersPath(board.stateDir);
  const held = loadAnswers(file);
  const earlier = resultOf(held, [key], ask, note.at);
  if (earlier !== null) return earlier === result ? [200, { key, ask, result: earlier }] : [409, { error: `${key} was already answered for that ask` }];
  if (!stillWaiting(note)) return [409, { error: `${key}'s wait on that ask has ended: the worker was told, and declares it again if it still needs it` }];
  saveAnswers(file, { answers: [...held.answers, { key, ask, at: note.at, result, answeredAt: board.now() }] });
  return [200, { key, ask, result }];
}
