import { useEffect, useState } from "react";
import type { Client } from "../api/client.ts";
import type { QueueView } from "../api/types.ts";
import { prunePicked, toggled } from "./publish-model.ts";

/** What a Publish press does, and what it last said. */
export type Publisher = Readonly<{
  /** True while a post is out: the Publish controls wait for the answer. */
  busy: boolean;
  /** The server's sentence for the last post it refused, or null. */
  refusal: string | null;
  clearRefusal: () => void;
  /** Posts `{ keys }` to `/api/publish` and has the shell read the queue again. Resolves true when the server accepted it. */
  publish: (keys: readonly string[]) => Promise<boolean>;
}>;

/**
 * A press on Publish, as `ui.html` does it: the keys are posted to `/api/publish`, which queues a publish run that posts their pull requests to the channel and never merges, and the shell reads the queue again so the
 * rows and the board follow at once. A refusal ("a publish run is under way: wait for it to finish") is the server's own sentence, kept as it came for the page's banner. Both pages share this hook, so a single
 * run and a batch post the same request.
 */
export function usePublish({ client, refresh }: Readonly<{ client: Client; refresh: () => void }>): Publisher {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const publish = async (keys: readonly string[]): Promise<boolean> => {
    setBusy(true);
    const answer = await client.publish(keys);
    setBusy(false);
    setRefusal(answer.ok ? null : answer.refusal);
    if (answer.ok) refresh();
    return answer.ok;
  };

  return { busy, refusal, clearRefusal: () => setRefusal(null), publish };
}

/** The ticks of the Runs page. */
export type Picked = Readonly<{ keys: readonly string[]; toggle: (key: string) => void; clear: () => void }>;

/**
 * The runs ticked for Publish. A queue read that shows a ticked run is no longer Ready to merge, or is held by a publish run, drops it for good, as `ui.html` does on every read, so it is not ticked again if it
 * comes back. `keys` is already pruned against the queue it is drawn with, so a tick never outlives the read that ends it. The ticks are the page's, not the filter's: a filter change keeps them.
 */
export function usePicked(queue: QueueView | null): Picked {
  const [picked, setPicked] = useState<readonly string[]>([]);
  useEffect(() => {
    if (queue === null) return;
    setPicked((before) => {
      const after = prunePicked(before, queue);
      return after.length === before.length ? before : after;
    });
  }, [queue]);
  return { keys: queue === null ? picked : prunePicked(picked, queue), toggle: (key) => setPicked((before) => toggled(before, key)), clear: () => setPicked([]) };
}
