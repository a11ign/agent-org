import { useCallback, useEffect, useState } from "react";
import type { QueueView } from "../api/types.ts";
import { useShell } from "../shell/ShellProvider.tsx";

/** The queue as the page knows it: what the poll last read, with the runs the server has just answered for until the poll has caught up. */
export type QueueNow = Readonly<{
  queue: QueueView | null;
  /** Takes in the queue a Queue or a Queue its children was answered with. */
  learn: (answered: QueueView) => void;
}>;

const holds = (queue: QueueView, key: string): boolean => queue.entries.some((entry) => entry.ticket.key === key);

/**
 * A successful Queue is answered with the queue after it, and the poll's own read of it may be one already in flight, which says nothing of the runs just made. So the answer's runs
 * are kept, beside the poll's, until a read of the poll holds every one of them: until then a ticket just queued is not offered to be queued again.
 */
export function useQueueNow(): QueueNow {
  const polled = useShell().queue.data;
  const [answered, setAnswered] = useState<QueueView | null>(null);
  useEffect(() => {
    if (answered !== null && polled !== null && answered.entries.every((entry) => holds(polled, entry.ticket.key))) setAnswered(null);
  }, [polled, answered]);
  const learn = useCallback((next: QueueView) => setAnswered(next), []);
  if (answered === null) return { queue: polled, learn };
  const missing = answered.entries.filter((entry) => polled === null || !holds(polled, entry.ticket.key));
  return { queue: polled === null ? answered : { ...polled, entries: [...polled.entries, ...missing] }, learn };
}
