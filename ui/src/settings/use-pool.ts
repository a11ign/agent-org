import { useEffect, useState } from "react";
import type { Answer } from "../api/answer.ts";
import type { Client } from "../api/client.ts";
import type { QueueView } from "../api/types.ts";
import type { LifecycleView } from "../lifecycle/Lifecycle.tsx";
import type { SaveState } from "./use-choices.ts";

export type Pool = Readonly<{
  /** How many runs work at once, as the instance last said; null until the queue has been read. */
  max: number | null;
  /** Whether workers are paused: the queue's word, where only an explicit `false` is started, as today's page reads it. Null until the queue has been read. */
  paused: boolean | null;
  maxState: SaveState;
  pauseState: SaveState;
  setMax: (text: string) => void;
  togglePause: () => void;
}>;

/**
 * The worker pool's two controls, which save as they change (`/api/max` and `/api/paused`). The queue the shell already polls is what they show; an answer is shown at once and the shell's
 * queue is asked to read again, so its badge and pill follow. A refusal says so beside the control and the control goes back to what the instance holds.
 */
export function usePool(client: Client, queue: LifecycleView<QueueView>): Pool {
  const [answered, setAnswered] = useState<QueueView | null>(null);
  const [maxState, setMaxState] = useState<SaveState>({ kind: "idle" });
  const [pauseState, setPauseState] = useState<SaveState>({ kind: "idle" });
  // A newer read of the queue is the instance's word again.
  useEffect(() => setAnswered(null), [queue.data]);
  const current = answered ?? queue.data;

  async function answer(change: Promise<Answer<QueueView>>, settle: (state: SaveState) => void) {
    settle({ kind: "saving" });
    const result = await change;
    if (result.ok) {
      setAnswered(result.data);
      settle({ kind: "saved" });
    } else {
      settle({ kind: "failed", sentence: result.refusal });
    }
    queue.refresh();
  }

  return {
    max: current?.max ?? null,
    paused: current === null ? null : current.paused !== false,
    maxState, pauseState,
    setMax: (text) => void answer(client.setMax(Number(text)), setMaxState),
    togglePause: () => void answer(current?.paused === false ? client.pause() : client.resume(), setPauseState),
  };
}
