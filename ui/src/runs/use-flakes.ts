import type { FlakesView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import { useShell } from "../shell/ShellProvider.tsx";

/**
 * The tests that need a fix (A11-300): those that flaked three times in seven days, read from `/api/flakes` as the shell polls its other reads. It is null until a read made now has answered and again while the last read
 * failed, never an empty list: a list nobody read would look like a board with no flaky test.
 */
export function useFlakes(): FlakesView | null {
  const { client, connection } = useShell();
  const flakes = usePoll(client.flakes, { connection, isEmpty: () => false });
  return flakes.state === "ready" && !flakes.cached ? flakes.data : null;
}
