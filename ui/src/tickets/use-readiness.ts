import { useEffect, useState } from "react";
import type { Client } from "../api/client.ts";
import type { ReadinessView } from "../api/types.ts";

// EACH TICKET'S READINESS SCORE (A11-443): asked once for the listed tickets each time the list changes, and again every READINESS_POLL_MS while any of them is still being scored. The instance
// answers from the scores it keeps by each description's hash, so asking again costs no model call; it only starts one for a description it has no score for. It only advises: nothing here holds a
// ticket back from the queue.

/** How often the page asks again while a ticket's score is still being made. */
export const READINESS_POLL_MS = 15_000;

/** Each listed ticket's readiness, by key: empty while the feature is off, before the instance answers, or on an instance from before the route. */
export type ReadinessScores = ReadonlyMap<string, ReadinessView>;

const NONE: ReadinessScores = new Map();

/** The readiness of the tickets `keys` names, as the instance answers it. A refusal shows none: the score only advises, so the page reads as it did before the feature. */
export function useReadiness(client: Client, keys: readonly string[]): ReadinessScores {
  const asked = [...keys].sort().join(",");
  const [answered, setAnswered] = useState<Readonly<{ asked: string; scores: ReadinessScores }>>({ asked: "", scores: NONE });
  useEffect(() => {
    if (asked === "") return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const answer = await client.readiness(asked.split(","));
      if (stopped || !answer.ok || answer.data.on !== true) return;
      const scores = new Map(Object.entries(answer.data.scores));
      setAnswered({ asked, scores });
      if ([...scores.values()].some((view) => view.state === "pending")) timer = setTimeout(() => void ask(), READINESS_POLL_MS);
    };
    void ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, asked]);
  return answered.asked === asked ? answered.scores : NONE;
}
