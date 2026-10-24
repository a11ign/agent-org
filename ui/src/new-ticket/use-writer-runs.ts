import { useCallback, useEffect, useRef, useState } from "react";
import type { WritersView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import { useShell } from "../shell/ShellProvider.tsx";

type Runs = WritersView["runs"];
type Run = Runs[number];

export type WriterRuns = Readonly<{
  runs: Runs;
  /** When the runs were last read, or null before they have been: a terminal link older than one poll interval is read again before it is followed. */
  readAt: number | null;
  /** The sentence of the last failure, a read that failed or a Stop or Dismiss the server refused, or null. */
  failure: string | null;
  retry: () => void;
  dismissFailure: () => void;
  stop: (id: string) => void;
  dismiss: (id: string) => void;
  /** Takes in the run an accepted request was answered with, which the poll may not hold yet. */
  learn: (run: Run) => void;
}>;

const holds = (runs: Runs, id: string): boolean => runs.some((run) => run.id === id);

/** The keys of every ticket the runs made, and the ids of the Grill runs on a ticket that have finished: what the tickets list is read again for. */
function newnessOf(runs: Runs): Readonly<{ made: ReadonlySet<string>; grilled: ReadonlySet<string> }> {
  return {
    made: new Set(runs.flatMap((run) => run.tickets.map((ticket) => ticket.key))),
    grilled: new Set(runs.filter((run) => run.ticket !== undefined && run.phase === "finished").map((run) => run.id)),
  };
}

/** Reads the tickets list again when the runs hold a ticket they did not, or a Grill of a row has finished, as `ui.html` reads Pick again. The first read only sets the baseline. */
function useRefreshTicketsOnNew(runs: Runs | null): void {
  const { tickets } = useShell();
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
 * The new-ticket requests of the instance: `/api/writer`, polled every 5s as the shell's reads are, with Stop and Dismiss. An accepted request is answered with its run, and the
 * poll's own read may be one already in flight that says nothing of it, so that run is kept beside the poll's until a read holds it.
 */
export function useWriterRuns(): WriterRuns {
  const { client, connection } = useShell();
  const poll = usePoll(client.writer, { connection, isEmpty: (view) => view.runs.length === 0 });
  const [answered, setAnswered] = useState<Runs>([]);
  const learn = useCallback((run: Run) => setAnswered((before) => [...before.filter(({ id }) => id !== run.id), run]), []);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [dismissedRead, setDismissedRead] = useState<string | null>(null);
  const polled = poll.data?.runs ?? null;

  useEffect(() => {
    if (polled !== null && answered.some((run) => holds(polled, run.id))) setAnswered((before) => before.filter((run) => !holds(polled, run.id)));
  }, [polled, answered]);
  const runs = polled === null ? answered : [...polled, ...answered.filter((run) => !holds(polled, run.id))];
  useRefreshTicketsOnNew(polled);

  const failure = refusal ?? (poll.state === "error" && poll.refusal !== dismissedRead ? poll.refusal : null);
  const act = (call: (id: string) => ReturnType<typeof client.stopWriterRun>) => async (id: string) => {
    const answer = await call(id);
    if (!answer.ok) return setRefusal(answer.refusal);
    setRefusal(null);
    poll.refresh();
  };
  return {
    runs, readAt: poll.readAt, failure,
    retry: () => { setRefusal(null); setDismissedRead(null); poll.refresh(); },
    dismissFailure: () => { setRefusal(null); setDismissedRead(poll.refusal); },
    stop: (id) => void act(client.stopWriterRun)(id),
    dismiss: (id) => void act(client.dismissWriterRun)(id),
    learn,
  };
}
