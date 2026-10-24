import { useEffect, useRef, useState } from "react";
import type { Answer } from "./answer.ts";
import { startPolling, type Poller } from "./poller.ts";
import type { ViewConnection } from "./types.ts";

/** Where a page's data is: `loading` until the first answer, then `ready` or `empty`, or `error` or `unreachable` (an SSH connection its proxy cannot reach) after a failure. */
export type PollState = "loading" | "ready" | "empty" | "error" | "unreachable";

export type PollView<T> = Readonly<{
  state: PollState;
  /** The last good data: kept through `error` and `unreachable`, which is what a "Last known" view shows. Null before the first success. */
  data: T | null;
  /** The last failure's sentence as the server worded it, or null after a success. */
  refusal: string | null;
}>;

export type PollOptions<T> = Readonly<{
  connection: ViewConnection | null;
  /** Whether a good answer is "nothing here": an empty array unless the page says otherwise. */
  isEmpty?: (data: T) => boolean;
}>;

const isEmptyList = (data: unknown): boolean => Array.isArray(data) && data.length === 0;

const LOADING = { state: "loading", data: null, refusal: null } as const;

/** The view an answer makes, given the one before it. */
function viewAfter<T>(before: PollView<T>, answer: Answer<T>, isEmpty: (data: T) => boolean): PollView<T> {
  if (answer.ok) return { state: isEmpty(answer.data) ? "empty" : "ready", data: answer.data, refusal: null };
  return { state: answer.unreachable ? "unreachable" : "error", data: before.data, refusal: answer.refusal };
}

/**
 * A page's data from one of the client's reads, polled (see `startPolling`) while the page is shown. A change of connection drops the read in flight and
 * starts again from `loading`, so one connection's data never lands on another's view. `refresh` is "Check now": it reads at once, and a failure it
 * meets counts toward the backoff like any other.
 */
export function usePoll<T>(read: (signal: AbortSignal) => Promise<Answer<T>>, { connection, isEmpty = isEmptyList }: PollOptions<T>): PollView<T> & Readonly<{ refresh: () => void }> {
  const connectionKey = connection === null ? "" : `${connection.kind}:${connection.name}`;
  const [held, setHeld] = useState<Readonly<{ connectionKey: string; view: PollView<T> }>>({ connectionKey, view: LOADING });
  const poller = useRef<Poller | undefined>(undefined);
  const latest = useRef({ read, isEmpty });
  useEffect(() => {
    latest.current = { read, isEmpty };
  });

  useEffect(() => {
    const running = startPolling<T>({
      read: (signal) => latest.current.read(signal),
      onAnswer: (answer) => setHeld((before) => ({ connectionKey, view: viewAfter(before.connectionKey === connectionKey ? before.view : LOADING, answer, latest.current.isEmpty) })),
    });
    poller.current = running;
    return () => running.stop();
  }, [connectionKey]);

  return { ...(held.connectionKey === connectionKey ? held.view : LOADING), refresh: () => poller.current?.refresh() };
}
