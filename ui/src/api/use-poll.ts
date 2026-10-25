import { useEffect, useMemo, useRef, useState } from "react";
import { looksLikeRestart } from "../../../src/ticket-mode/board-view/reconnect.ts";
import type { Answer } from "./answer.ts";
import { startPolling, type Poller } from "./poller.ts";
import { POLL_MS } from "./poll-schedule.ts";
import { readCached, writeCached } from "./session-cache.ts";
import type { ViewConnection } from "./types.ts";

/**
 * Where a page's data is: `loading` until the first answer, then `ready` or `empty`, or after a failure `error` (an error the server answered with), `unreachable` (an SSH connection
 * its proxy cannot reach) or `reconnecting` (no answer, or a 502 or 503: the instance or the service in front of it is restarting, and the poll is trying again).
 */
export type PollState = "loading" | "ready" | "empty" | "error" | "unreachable" | "reconnecting";

export type PollView<T> = Readonly<{
  state: PollState;
  /** The last good data: kept through `error`, `unreachable` and `reconnecting`, which is what a "Last known" view shows. Null before the first success. */
  data: T | null;
  /** The last failure's sentence as the server worded it, or null after a success. */
  refusal: string | null;
  /**
   * True while `data` is the answer the tab kept from an earlier page (`session-cache.ts`) and no read made here has answered with data yet (A11-270). A control that writes waits for
   * fresh data, so a person does not meet the server's refusal of a stale base just for clicking in the first moment after a navigation.
   */
  cached: boolean;
}>;

export type PollOptions<T> = Readonly<{
  connection: ViewConnection | null;
  /** Whether a good answer is "nothing here": an empty array unless the page says otherwise. */
  isEmpty?: (data: T) => boolean;
  /** False for a read made once per connection and not again, unless `refresh` asks (see `startPolling`). True by default. */
  repeat?: boolean;
  /** The longest wait between reads while they fail, asked each time one is scheduled (see `startPolling`): the shell caps it while the page shows the Updating screen. */
  maxWaitMs?: () => number;
}>;

const isEmptyList = (data: unknown): boolean => Array.isArray(data) && data.length === 0;

/** What a hook returns beyond the view: `refresh` reads now, `readAt` is when the last good data was read (null before the first), and `current` is the data fresh enough to act on. */
export type Poll<T> = PollView<T> & Readonly<{ refresh: () => void; readAt: number | null; current: () => Promise<T | null> }>;

type Held<T> = Readonly<{ connectionKey: string; view: PollView<T>; readAt: number | null }>;

const LOADING = { state: "loading", data: null, refusal: null, cached: false } as const;

/** A read the poll is given: the client's reads name their path, which is where the tab keeps the answer; a read with none is not kept. */
export type PollRead<T> = ((signal: AbortSignal) => Promise<Answer<T>>) & Readonly<{ path?: string }>;

/** What a view is held under: the connection it was read from. */
const keyOf = (connection: ViewConnection | null): string => (connection === null ? "" : `${connection.kind}:${connection.name}`);

/** Where a read for `connection` starts: the answer the tab kept for its path, drawn at once and read again, else `loading`. */
function startOf<T>(connection: ViewConnection | null, path: string | undefined, isEmpty: (data: T) => boolean): Held<T> {
  const connectionKey = keyOf(connection);
  const kept = path === undefined ? null : readCached<T>(connection, path);
  if (kept === null) return { connectionKey, view: LOADING, readAt: null };
  return { connectionKey, view: { state: isEmpty(kept.data) ? "empty" : "ready", data: kept.data, refusal: null, cached: true }, readAt: kept.readAt };
}

/** Whether data read for `connectionKey` was read no more than one poll interval ago, so a link built from it can be trusted. */
function isFresh<T>(held: Held<T>, connectionKey: string): boolean {
  if (held.connectionKey !== connectionKey || held.readAt === null) return false;
  return Date.now() - held.readAt <= POLL_MS;
}

/** The state a failed answer makes: unreachable for an SSH remote its proxy cannot reach, reconnecting for a restart, and an error for anything the server answered with. */
function failureOf(connection: ViewConnection | null, answer: Extract<Answer<unknown>, { ok: false }>): PollState {
  if (answer.unreachable) return "unreachable";
  return looksLikeRestart(connection, answer.status, answer.refusal) ? "reconnecting" : "error";
}

/**
 * The data a failure leaves shown: what the page already holds, which is at least as new as the proxy's copy, since it wrote that copy from those same answers; else, for a page that has
 * read nothing yet, the proxy's last known answer of an instance it cannot reach.
 */
export const dataAfterFailure = <T,>(before: PollView<T>, answer: Extract<Answer<T>, { ok: false }>): T | null => before.data ?? (answer.unreachable ? (answer.lastKnown?.data ?? null) : null);

/** The view an answer makes, given the one before it. */
function viewAfter<T>(before: PollView<T>, answer: Answer<T>, isEmpty: (data: T) => boolean, connection: ViewConnection | null): PollView<T> {
  if (answer.ok) return { state: isEmpty(answer.data) ? "empty" : "ready", data: answer.data, refusal: null, cached: false };
  return { state: failureOf(connection, answer), data: dataAfterFailure(before, answer), refusal: answer.refusal, cached: before.cached };
}

/**
 * A page's data from one of the client's reads, polled (see `startPolling`) while the page is shown. It starts from the answer the tab kept for the read (`cached`), else from `loading`, and
 * keeps each good answer for the next page. A change of connection drops the read in flight and starts again from that connection's kept answer or `loading`, so one connection's data never lands on another's view. `refresh` is "Check now": it reads at once and starts the backoff over, so a failure it
 * meets waits 2s before the next read. A page that has read nothing yet and finds its SSH connection unreachable shows the proxy's last known data, if it kept any. `current` is for a click on a link built from the data (a run's terminal): the held data while it was read no
 * more than one poll interval ago, else a read made now, resolving to its data, or to null when that read fails.
 */
export function usePoll<T>(read: PollRead<T>, { connection, isEmpty = isEmptyList, repeat = true, maxWaitMs }: PollOptions<T>): Poll<T> {
  const connectionKey = keyOf(connection);
  // The kept answer is looked up once per connection and path, not on every render: the queue's is large.
  const start = useMemo(() => startOf(connection, read.path, isEmpty), [connectionKey, read.path]);
  const [held, setHeld] = useState<Held<T>>(start);
  const poller = useRef<Poller<T> | undefined>(undefined);
  const latest = useRef({ read, isEmpty, connection, held, maxWaitMs, start });
  useEffect(() => {
    latest.current = { read, isEmpty, connection, held, maxWaitMs, start };
  });

  useEffect(() => {
    const running = startPolling<T>({
      read: (signal) => latest.current.read(signal),
      repeat,
      maxWaitMs: () => latest.current.maxWaitMs?.() ?? Infinity,
      onAnswer: (answer) => {
        const { read: { path }, connection: answered } = latest.current;
        if (answer.ok && path !== undefined) writeCached(answered, path, answer.data);
        setHeld((before) => {
          const prior = before.connectionKey === connectionKey ? before : latest.current.start;
          return { connectionKey, view: viewAfter(prior.view, answer, latest.current.isEmpty, latest.current.connection), readAt: answer.ok ? Date.now() : prior.readAt };
        });
      },
    });
    poller.current = running;
    return () => running.stop();
  }, [connectionKey, repeat]);

  const shown = held.connectionKey === connectionKey ? held : start;
  const current = async (): Promise<T | null> => {
    const { view } = latest.current.held;
    if (view.data !== null && isFresh(latest.current.held, connectionKey)) return view.data;
    const answer = await poller.current?.refresh();
    return answer?.ok ? answer.data : null;
  };
  return { ...shown.view, readAt: shown.readAt, refresh: () => void poller.current?.refresh(), current };
}
