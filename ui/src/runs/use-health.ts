import type { InterventionsView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import { useShell } from "../shell/ShellProvider.tsx";

/**
 * The board's health number (A11-257): the person-interventions of the last 7 days and today's total, read from `/api/interventions` as the shell polls its other reads. It is null until a read has
 * answered and again while the last read failed, never a zero: a wrong 0 would look healthy.
 */
export function useHealth(): InterventionsView | null {
  const { client, connection } = useShell();
  const health = usePoll(client.interventions, { connection, isEmpty: () => false });
  return health.state === "ready" ? health.data : null;
}
