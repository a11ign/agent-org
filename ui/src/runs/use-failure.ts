import { useState } from "react";
import type { QueueView } from "../api/types.ts";
import type { LifecycleView } from "../lifecycle/Lifecycle.tsx";
import type { Pool } from "../settings/use-pool.ts";
import type { SaveState } from "../settings/use-choices.ts";
import { NOT_PUBLISHED } from "./publish-model.ts";
import type { RunActions } from "./use-run-actions.ts";
import type { Publisher } from "./use-publish.ts";

/** What the banner shows: the sentence, and the heading it carries when the sentence is a failed publish. */
export type Failure = Readonly<{ sentence: string | null; title: string | undefined; retry: () => void; dismiss: () => void }>;

/**
 * The one failure the page shows: the server's sentence for an action a row's button was refused, else for a Publish it refused, else the publisher's reason when the publish run failed (`failedRun`, null on a
 * machine with no publisher), else for a Pause or Start workers it was refused, else for a queue read that failed. The two publish sentences are headed "Not published." Retry clears the refusals and
 * reads the queue again; Dismiss clears them too, and the banner hides that sentence until the next failure.
 */
export function useFailure({ queue, actions, publisher, failedRun, pool }: Readonly<{ queue: LifecycleView<QueueView>; actions: RunActions; publisher: Publisher; failedRun: string | null; pool: Pool }>): Failure {
  // A pool refusal is a state the hook keeps; the page marks the one it has cleared, and a new refusal is a new state.
  const [cleared, setCleared] = useState<SaveState | null>(null);
  const poolSentence = pool.pauseState.kind === "failed" && pool.pauseState !== cleared ? pool.pauseState.sentence : null;
  const readSentence = queue.state === "error" ? queue.refusal : null;
  const clear = () => {
    actions.clearRefusal();
    publisher.clearRefusal();
    setCleared(pool.pauseState);
  };
  const publishSentence = publisher.refusal ?? failedRun;
  const rowSentence = actions.refusal;
  return {
    sentence: rowSentence ?? publishSentence ?? poolSentence ?? readSentence,
    title: rowSentence === null && publishSentence !== null ? NOT_PUBLISHED : undefined,
    retry: () => {
      clear();
      queue.refresh();
    },
    dismiss: clear,
  };
}
