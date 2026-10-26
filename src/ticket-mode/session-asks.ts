// @ts-check
// module: the person's session's queue (A11-277, A11-302) -- `GET /api/session-asks`, what the board asks the session to run, each with the route to answer on
//
// THE SESSION'S QUEUE IS THE BOARD'S API, WITH NO NEW SCREEN (A11-275's routing). The board cannot message a session; it lists what it asks, and the session reads the list. A11-302 took the After-merge checks out of it: the org
// verifies its own work, so the session is no runner of a check (it may read the results on a ticket's Run detail, as anyone can). What is left is the run that waits on something only the session can do (`wait-on/`, A11-275).
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";
import { type AnswersFile, loadAnswers, sessionAnswersPath, unansweredRuns, waitingRuns } from "./session-answers.ts";

/**
 * A run that waits on something only the session can do (A11-275): its ticket and the ticket's address, the run's pull requests, the ask in the worker's words (the exact command, where it runs and what a pass looks
 * like), when the worker declared it, and the route the result is posted to (`POST`, with `{ ask, result }`).
 */
export type WaitingRunAsk = Readonly<{
  kind: "waiting-run";
  key: string;
  url: string;
  pullRequests: readonly string[];
  ask: string;
  sentAt: number;
  answer: string;
}>;

/** One thing the board asks the session to do: a run that waits on something only the session can do. */
export type SessionAsk = WaitingRunAsk;

/** What `GET /api/session-asks` answers: the board's clock as it listed them, which a session's next read passes as `since`, and the asks, oldest first. */
export type SessionAsksView = Readonly<{ at: number; asks: readonly SessionAsk[] }>;

/** The route a waiting run's result is posted to: `/api/session-asks/<KEY>/answer`. PURE. */
export const answerRouteOf = (key: string): string => `/api/session-asks/${key}/answer`;

/**
 * The asks the runs of `queue` make of the session that it has not answered, oldest first. `?since` does not filter them: `sentAt` is when the worker wrote its outcome, which can be earlier than a read the board had not yet
 * seen it at, so a read since then would never list the ask; every open ask is listed until it is answered. PURE.
 */
export function waitingRunAsks(queue: Queue, answers: AnswersFile): WaitingRunAsk[] {
  return unansweredRuns(queue, answers).sort((a, b) => a.at - b.at)
    .map((run) => ({ kind: "waiting-run", key: run.key, url: run.url, pullRequests: run.pullRequests, ask: run.ask, sentAt: run.at, answer: answerRouteOf(run.key) }));
}

/** The `since` a read names, or undefined for none. One that is not a time THROWS, which the board answers with 400 and the sentence. */
function sinceOf(query: URLSearchParams): number | undefined {
  const since = query.get("since");
  if (since === null) return undefined;
  if (!/^\d+$/.test(since)) throw new Error("since must be the `at` of an earlier read, in milliseconds");
  return Number(since);
}

/** What the route needs of the board: where its state is, and its clock. */
export type SessionAsksBoard = Readonly<{ stateDir: string; now: () => number; queue: () => Queue }>;

/**
 * `GET /api/session-asks`: every ask a run waits on the session for that is not answered, sent when its worker declared it (listing it writes nothing, and `since` does not filter it). Undefined when the request names another route.
 * An answers file that cannot be read THROWS: listed as empty, the session would be told it has nothing to run.
 */
export function sessionAsksRoute(board: SessionAsksBoard, method: string, path: string, query: URLSearchParams): [number, SessionAsksView] | undefined {
  if (method !== "GET" || path !== "/api/session-asks") return undefined;
  sinceOf(query);
  const at = board.now();
  // A queue with no run waiting on the session never reads the answers file.
  const waiting = waitingRuns(board.queue()).length === 0 ? [] : waitingRunAsks(board.queue(), loadAnswers(sessionAnswersPath(board.stateDir)));
  return [200, { at, asks: waiting }];
}
