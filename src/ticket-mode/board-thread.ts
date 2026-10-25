// @ts-check
// module: the instance's board thread's side of the split (A11-282) -- the snapshot it posts the request thread, the forwarded requests it answers, and the request thread's life
//
// THE BOARD THREAD IS THE QUEUE'S ONE WRITER, AS THE INSTANCE ALWAYS WAS. It keeps the pool, the tick and the sweeps, whose `gh`, `git` and `herdr` calls are synchronous. The HTTP
// server runs on the request thread (`request-thread.ts`), so those calls hold only this thread: a read is answered from the latest snapshot, and a write is forwarded here whole and
// answered by `createBoard(...).api`, the routes the instance always had.
//
// A SNAPSHOT IS POSTED AFTER EVERY QUEUE CHANGE AND EVERY SNAPSHOT_MS, changed or not: the request thread reads the snapshot's age as how long this thread has been held, so a quiet board
// must not look like a held one. The terminal address is worked out here, so the request thread never asks the exposure.
//
// A REQUEST THREAD THAT DIES IS STARTED AGAIN, at most RESTARTS times in RESTART_WINDOW_MS. One more death ends the instance with 1, and its service starts it again, as a failed
// start always has.
import type { createBoard } from "./server.ts";
import type { HealthView } from "./health-route.ts";
import { applyCopies, type BoardSnapshot, type CallMessage, copiesOf, type RequestThreadData, type ToBoard, type ToRequests } from "./thread-messages.ts";

/** How often a snapshot is posted when nothing changed, in ms. */
export const SNAPSHOT_MS = 1_000;
/** How many times the request thread is started again within RESTART_WINDOW_MS before the instance gives up. */
export const RESTARTS = 3;
export const RESTART_WINDOW_MS = 60_000;

/** What the board thread reads and routes through: the board `createBoard` made. */
export type ThreadBoard = Pick<ReturnType<typeof createBoard>, "api" | "known" | "store" | "pool" | "update" | "terminalAddress">;

/** The request thread as the board thread holds it: a `Worker`, or a test's stand-in. */
export type RequestThread = Readonly<{
  postMessage: (message: ToRequests) => void;
  on: ((event: "message", listener: (message: ToBoard) => void) => unknown) & ((event: "exit", listener: (code: number) => void) => unknown)
    & ((event: "error", listener: (error: Error) => void) => unknown);
}>;

/** The snapshot of `board` as it is now, with the terminal address last worked out and the board thread's health. */
export function snapshotOf(board: Pick<ThreadBoard, "store" | "pool" | "update">, terminal: string | null, health: HealthView, at: number): BoardSnapshot {
  const { pool } = board;
  return { queue: board.store.get(), held: pool.held?.() ?? null, pullReviews: pool.pullReviews?.() ?? {}, claimWarning: pool.claimWarning?.() ?? null, reviewerState: pool.reviewerState?.() ?? null,
    terminal, update: board.update(), loop: health.loop.board, blocking: health.blocking, at };
}

/**
 * The answer to a forwarded request: its copies of the page's tickets are put on the board, the board's own routes answer it, and what they left for those tickets goes back.
 * A route that throws is a 400 with its sentence, as a request on the board's own socket was.
 */
export async function answerCall(board: Pick<ThreadBoard, "api" | "known">, call: CallMessage): Promise<Extract<ToRequests, { kind: "answer" }>> {
  applyCopies(board.known, call.known);
  const keys = call.known.tickets.map(([key]) => key);
  let answer: [number, unknown];
  try {
    answer = await board.api(call.method, call.path, call.body, new URLSearchParams(call.query));
  } catch (err) {
    answer = [400, { error: String((err as Error)?.message ?? err) }];
  }
  return { kind: "answer", id: call.id, status: answer[0], value: answer[1], known: copiesOf(board.known, keys) };
}

/** Whether a death at `now` may still be followed by a start: RESTARTS deaths within RESTART_WINDOW_MS are, one more is not. */
export function restartBudget(now: () => number = Date.now): () => boolean {
  const deaths: number[] = [];
  return () => {
    const at = now();
    deaths.push(at);
    while (deaths.length > 0 && deaths[0] <= at - RESTART_WINDOW_MS) deaths.shift();
    return deaths.length <= RESTARTS;
  };
}

export type BoardThreadDeps = Readonly<{
  board: ThreadBoard;
  /** The board thread's health: its loop and the spawns that held it. */
  health: () => HealthView;
  /** What the request thread starts with, but its snapshot, which is taken as it starts. */
  data: Omit<RequestThreadData, "snapshot">;
  /** The terminal address as the board worked it out at start. */
  terminal: string | null;
  /** Starts a request thread with `data`. */
  start: (data: RequestThreadData) => RequestThread;
  /** Calls `run` every `ms`: `setInterval` unless a test drives it. */
  every?: (run: () => void, ms: number) => unknown;
  now?: () => number;
  /** Said once, when the request thread first listens. */
  listening?: (port: number) => void;
  err?: (line: string) => void;
  /** Ends the instance when the request thread has died too often. */
  exit?: (code: number) => void;
}>;

/** Starts the request thread and serves it: snapshots, forwarded requests and restarts. Answers `queueChanged`, which `createBoard`'s `queueChanged` calls. */
export function startBoardThread(deps: BoardThreadDeps): Readonly<{ queueChanged: () => void }> {
  const { board, health, start, every = setInterval, now = Date.now, listening = () => undefined, err = (line) => process.stderr.write(line), exit = (code) => process.exit(code) } = deps;
  let terminal = deps.terminal;
  let heard = false;
  const mayRestart = restartBudget(now);
  const snapshot = () => snapshotOf(board, terminal, health(), now());

  /** Starts a request thread, and answers how to tell it something. */
  const run = (): ((message: ToRequests) => void) => {
    const thread = start({ ...deps.data, snapshot: snapshot() });
    const post = (message: ToRequests): void => {
      try {
        thread.postMessage(message);
      } catch (error) {
        // A value that cannot be cloned fails that message, never this thread: a call is still answered, as the socket answered a failure.
        err(`ticket:serve: the request thread could not be told a ${message.kind}: ${String((error as Error)?.message ?? error)}\n`);
        if (message.kind === "answer") thread.postMessage({ kind: "answer", id: message.id, status: 500, value: { error: "the instance failed to answer" }, known: { tickets: [], claims: [] } });
      }
    };
    thread.on("message", (message) => {
      if (message.kind === "listening") {
        if (!heard) listening(message.port);
        heard = true;
        return;
      }
      void answerCall(board, message).then(post);
    });
    thread.on("error", (error) => err(`ticket:serve: the request thread failed: ${String(error?.stack ?? error)}\n`));
    thread.on("exit", (code) => {
      if (!mayRestart()) {
        err(`ERROR ticket:serve: the request thread exited ${code}, its ${RESTARTS + 1}th exit within ${RESTART_WINDOW_MS / 1000} s, so the instance stops and its service starts it again\n`);
        exit(1);
        return;
      }
      err(`ticket:serve: the request thread exited ${code}, so it is started again\n`);
      tell = run();
    });
    return post;
  };

  let tell = run();
  const postSnapshot = () => tell({ kind: "snapshot", snapshot: snapshot() });
  every(() => {
    void board.terminalAddress().then((address) => { terminal = address; }, () => undefined).finally(postSnapshot);
  }, SNAPSHOT_MS);
  return { queueChanged: postSnapshot };
}
