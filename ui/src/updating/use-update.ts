import { useEffect, useState } from "react";
import type { QueueView } from "../api/types.ts";
import type { PollView } from "../api/use-poll.ts";
import { BACK_AFTER_MS, IDLE, SLOW_AFTER_MS, trackAfter, viewOf, type UpdateView } from "./update-model.ts";

/** The default way a Back moves on: the page loads its own address again, so it runs the new version's code, which the old page's code may not match. */
const reloadPage = (): void => globalThis.location.reload();

/**
 * Whether the page is in the middle of an update, from the shell's queue poll (see `update-model.ts` for the rule): `none`, `updating` (slow after a minute of failed polls) or `back`. The poll
 * itself keeps going; this only reads its state. A Back reloads the page after BACK_AFTER_MS through `reload`. `queue` is the poll's view, whose data is the last good read through a failure.
 */
export function useUpdate(queue: Pick<PollView<QueueView>, "state" | "data">, reload: () => void = reloadPage): UpdateView {
  const [track, setTrack] = useState(IDLE);
  const [now, setNow] = useState(Date.now);
  // Adjusting state while rendering, so the first render of a failed poll already shows the screen and not a frame of "Reconnecting...". `trackAfter` returns the same object when nothing changed.
  const seen = trackAfter(track, { state: queue.state, update: queue.data?.update ?? null, at: Date.now() });
  if (seen !== track) setTrack(seen);

  const since = seen.outage?.since;
  useEffect(() => {
    if (since === undefined) return undefined;
    const slowIn = since + SLOW_AFTER_MS - Date.now();
    const timer = setTimeout(() => setNow(Math.max(Date.now(), since + SLOW_AFTER_MS)), Math.max(slowIn, 0));
    return () => clearTimeout(timer);
  }, [since]);

  const view = viewOf(seen, now);
  const isBack = view.kind === "back";
  useEffect(() => {
    if (!isBack) return undefined;
    const timer = setTimeout(reload, BACK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [isBack, reload]);
  return view;
}
