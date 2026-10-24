import { useEffect, useRef, useState } from "react";
import { looksLikeRestart } from "../../../src/ticket-mode/board-view/reconnect.ts";
import type { Answer } from "./answer.ts";
import { startPolling, type Poller } from "./poller.ts";
import { POLL_MS } from "./poll-schedule.ts";
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
}>;

export type PollOptions<T> = Readonly<{
  connection: ViewConnection | null;
  /** Whether a good answer is "nothing here": an empty array unless the page says otherwise. */
  isEmpty?: (data: T) => boolean;
  /** False for a read made once per connection and not again, unless `refresh` asks (see `startPolling`). True by default. */
  repeat?: boolean;
}>;

const isEmptyList = (data: unknown): boolean => Array.isArray(data) && data.length === 0;

/** What a hook returns beyond the view: `refresh` reads now, `readAt` is when the last good data was read (null before the first), and `current` is the data fresh enough to act on. */
export type Poll<T> = PollView<T> & Readonly<{ refresh: () => void; readAt: number | null; current: () => Promise<T | null> }>;

type Held<T> = Readonly<{ connectionKey: string; view: PollView<T>; readAt: number | null }>;

const LOADING = { state: "loading", data: null, refusal: null } as const;

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

/** The view an answer makes, given the one before it. */
function viewAfter<T>(before: PollView<T>, answer: Answer<T>, isEmpty: (data: T) => boolean, connection: ViewConnection | null): PollView<T> {
  if (answer.ok) return { state: isEmpty(answer.data) ? "empty" : "ready", data: answer.data, refusal: null };
  return { state: failureOf(connection, answer), data: before.data, refusal: answer.refusal };
}

/**
 * A page's data from one of the client's reads, polled (see `startPolling`) while the page is shown. A change of connection drops the read in flight and
 * starts again from `loading`, so one connection's data never lands on another's view. `refresh` is "Check now": it reads at once, and a failure it
 * meets counts toward the backoff like any other. `current` is for a click on a link built from the data (a run's terminal): the held data while it was read no
 * more than one poll interval ago, else a read made now, resolving to its data, or to null when that read fails.
 */
export function usePoll<T>(read: (signal: AbortSignal) => Promise<Answer<T>>, { connection, isEmpty = isEmptyList, repeat = true }: PollOptions<T>): Poll<T> {
  const connectionKey = connection === null ? "" : `${connection.kind}:${connection.name}`;
  const [held, setHeld] = useState<Held<T>>({ connectionKey, view: LOADING, readAt: null });
  const poller = useRef<Poller<T> | undefined>(undefined);
  const latest = useRef({ read, isEmpty, connection, held });
  useEffect(() => {
    latest.current = { read, isEmpty, connection, held };
  });

  useEffect(() => {
    const running = startPolling<T>({
      read: (signal) => latest.current.read(signal),
      repeat,
      onAnswer: (answer) =>
        setHeld((before) => {
          const prior = before.connectionKey === connectionKey ? before : { connectionKey, view: LOADING, readAt: null };
          return { connectionKey, view: viewAfter(prior.view, answer, latest.current.isEmpty, latest.current.connection), readAt: answer.ok ? Date.now() : prior.readAt };
        }),
    });
    poller.current = running;
    return () => running.stop();
  }, [connectionKey, repeat]);

  const shown = held.connectionKey === connectionKey ? held : { connectionKey, view: LOADING, readAt: null };
  const current = async (): Promise<T | null> => {
    const { view } = latest.current.held;
    if (view.data !== null && isFresh(latest.current.held, connectionKey)) return view.data;
    const answer = await poller.current?.refresh();
    return answer?.ok ? answer.data : null;
  };
  return { ...shown.view, readAt: shown.readAt, refresh: () => void poller.current?.refresh(), current };
}
