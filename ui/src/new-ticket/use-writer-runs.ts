import { useCallback, useEffect, useRef, useState } from "react";
import type { Client } from "../api/client.ts";
import type { ViewConnection, WritersView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";

type Runs = WritersView["runs"];
type Run = Runs[number];

export type WriterRuns = Readonly<{
  runs: Runs;
  /** When the runs were last read, or null before they have been: a terminal link older than one poll interval is read again before it is followed. */
  readAt: number | null;
  /** True while the runs are the tab's kept copy (A11-270): Stop and Dismiss wait for the instance's own answer. */
  cached: boolean;
  /** The sentence of the last failure, a read that failed or a Stop, Dismiss or Clear all the server refused, or null. */
  failure: string | null;
  /** The sentence of the last Stop, Dismiss or Clear all the server refused, or null: what the notification centre shows, which has no read to retry. */
  refusal: string | null;
  /** The ids of the requests a Stop or Dismiss is out for, and `ALL_FINISHED` while a Clear all is. */
  acting: ReadonlySet<string>;
  retry: () => void;
  dismissFailure: () => void;
  /** Hides the sentence of the last refused Stop, Dismiss or Clear all. */
  dismissRefusal: () => void;
  stop: (id: string) => void;
  dismiss: (id: string) => void;
  /** Clears every finished request at once, whatever the panel's filter. */
  dismissFinished: () => void;
  /** Takes in the run an accepted request was answered with, which the poll may not hold yet. */
  learn: (run: Run) => void;
}>;

const noop = () => undefined;

/** The requests of an instance that writes no tickets, and before it is known to: none, and nothing to act on. */
export const NO_WRITERS: WriterRuns = {
  runs: [], readAt: null, cached: false, failure: null, refusal: null, acting: new Set(), retry: noop, dismissFailure: noop, dismissRefusal: noop, stop: noop, dismiss: noop, dismissFinished: noop, learn: noop,
};

/** What `acting` holds while a Clear all is out. A request's id is letters, digits, `_` and `-`, so it is never this. */
export const ALL_FINISHED = "*";

const holds = (runs: Runs, id: string): boolean => runs.some((run) => run.id === id);

/** The keys of every ticket the runs made, and the ids of the Grill runs on a ticket that have finished: what the tickets list is read again for. */
function newnessOf(runs: Runs): Readonly<{ made: ReadonlySet<string>; grilled: ReadonlySet<string> }> {
  return {
    made: new Set(runs.flatMap((run) => run.tickets.map((ticket) => ticket.key))),
    grilled: new Set(runs.filter((run) => run.ticket !== undefined && run.phase === "finished").map((run) => run.id)),
  };
}

/** Reads the tickets list again when the runs hold a ticket they did not, or a Grill of a row has finished, as `ui.html` reads Pick again. The first read only sets the baseline. */
function useRefreshTicketsOnNew(runs: Runs | null, tickets: Readonly<{ refresh: () => void }>): void {
  const seen = useRef<ReturnType<typeof newnessOf> | null>(null);
  useEffect(() => {
    if (runs === null) return;
    const now = newnessOf(runs);
    const before = seen.current;
    seen.current = now;
    if (before === null) return;
    if ([...now.made].some((key) => !before.made.has(key)) || [...now.grilled].some((id) => !before.grilled.has(id))) tickets.refresh();
  }, [runs, tickets]);
}

/**
 * The new-ticket requests of the instance: `/api/writer`, polled every 5s as the shell's reads are, with Stop, Dismiss and Clear all. The shell owns it, so every page has the same runs: the
 * Tickets page draws those under way and the notification centre those finished. An accepted request is answered with its run, and the poll's own read may be one already in flight that says
 * nothing of it, so that run is kept beside the poll's until a read holds it. `tickets` is the tickets read, which is read again when the runs hold a ticket it did not. `enabled` is false for an
 * instance that writes no tickets, which is not asked.
 */
export function useWriterRuns({ client, connection, tickets, enabled }: Readonly<{ client: Client; connection: ViewConnection | null; tickets: Readonly<{ refresh: () => void }>; enabled: boolean }>): WriterRuns {
  const poll = usePoll(client.writer, { connection, isEmpty: (view) => view.runs.length === 0, enabled });
  const [answered, setAnswered] = useState<Runs>([]);
  const learn = useCallback((run: Run) => setAnswered((before) => [...before.filter(({ id }) => id !== run.id), run]), []);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [dismissedRead, setDismissedRead] = useState<string | null>(null);
  const [acting, setActing] = useState<ReadonlySet<string>>(new Set());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const polled = poll.data?.runs ?? null;

  useEffect(() => {
    if (polled !== null && answered.some((run) => holds(polled, run.id))) setAnswered((before) => before.filter((run) => !holds(polled, run.id)));
  }, [polled, answered]);
  // A dismissed request leaves the strip at once, and its id is forgotten once a read no longer lists it.
  useEffect(() => {
    if (polled !== null && [...gone].some((id) => !holds(polled, id))) setGone((before) => new Set([...before].filter((id) => holds(polled, id))));
  }, [polled, gone]);
  useEffect(() => {
    if (poll.state !== "error") setDismissedRead(null);
  }, [poll.state]);
  const listed = polled === null ? answered : [...polled, ...answered.filter((run) => !holds(polled, run.id))];
  const runs = listed.filter((run) => !gone.has(run.id));
  useRefreshTicketsOnNew(polled, tickets);

  const failure = refusal ?? (poll.state === "error" && poll.refusal !== dismissedRead ? poll.refusal : null);
  const act = async (key: string, call: () => ReturnType<typeof client.stopWriterRun>, afterwards: () => void = () => undefined) => {
    if (acting.has(key)) return;
    setActing((before) => new Set(before).add(key));
    const answer = await call();
    setActing((before) => new Set([...before].filter((other) => other !== key)));
    if (!answer.ok) return setRefusal(answer.refusal);
    setRefusal(null);
    afterwards();
    poll.refresh();
  };
  const leave = (ids: readonly string[]) => setGone((before) => new Set([...before, ...ids]));
  const finishedIds = runs.filter((run) => run.phase === "finished").map((run) => run.id);
  return {
    runs, readAt: poll.readAt, cached: poll.cached, failure, refusal, acting,
    retry: () => { setRefusal(null); setDismissedRead(null); poll.refresh(); },
    dismissFailure: () => { setRefusal(null); setDismissedRead(poll.refusal); },
    dismissRefusal: () => setRefusal(null),
    stop: (id) => void act(id, () => client.stopWriterRun(id)),
    dismiss: (id) => void act(id, () => client.dismissWriterRun(id), () => leave([id])),
    dismissFinished: () => void act(ALL_FINISHED, () => client.dismissFinishedWriterRuns(finishedIds), () => leave(finishedIds)),
    learn,
  };
}
