import { useState } from "react";
import type { QueueView } from "../api/types.ts";
import type { LifecycleView } from "../lifecycle/Lifecycle.tsx";
import type { Pool } from "../settings/use-pool.ts";
import type { SaveState } from "../settings/use-choices.ts";
import type { RunActions } from "./use-run-actions.ts";

export type Failure = Readonly<{ sentence: string | null; retry: () => void; dismiss: () => void }>;

/**
 * The one failure the page shows: the server's sentence for an action a row's button was refused, else for a Pause or Start workers it was refused, else for a queue read that failed. Retry clears the
 * refusals and reads the queue again; Dismiss clears them too, and the banner hides that sentence until the next failure.
 */
export function useFailure(queue: LifecycleView<QueueView>, actions: RunActions, pool: Pool): Failure {
  // A pool refusal is a state the hook keeps; the page marks the one it has cleared, and a new refusal is a new state.
  const [cleared, setCleared] = useState<SaveState | null>(null);
  const poolSentence = pool.pauseState.kind === "failed" && pool.pauseState !== cleared ? pool.pauseState.sentence : null;
  const readSentence = queue.state === "error" ? queue.refusal : null;
  const clear = () => {
    actions.clearRefusal();
    setCleared(pool.pauseState);
  };
  return {
    sentence: actions.refusal ?? poolSentence ?? readSentence,
    retry: () => {
      clear();
      queue.refresh();
    },
    dismiss: clear,
  };
}
