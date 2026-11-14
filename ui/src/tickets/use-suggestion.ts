import { useEffect, useState } from "react";
import type { Client } from "../api/client.ts";
import type { Suggestion } from "../api/types.ts";

// THE FOOTER'S SUGGESTION (A11-435): the model and effort past runs of the selected tickets' kind went best on, asked once each time the selection changes. It only advises: nothing here
// changes the batch's model or effort, which the person still chooses.

/** What the footer shows of the suggestion: the suggestion, or null for none, and the instance's sentence when its outcome log could not be read. */
export type SuggestionState = Readonly<{ suggestion: Suggestion | null; refusal: string | null }>;

const NONE: SuggestionState = { suggestion: null, refusal: null };

/**
 * The suggestion for the tickets `keys` names, as the instance answers it. An instance from before the route (any status but 400) shows none: only the route's own refusal, an unreadable
 * outcome log, is shown, since that is an error and not "no suggestion".
 */
export function useSuggestion(client: Client, keys: readonly string[]): SuggestionState {
  const asked = [...keys].sort().join(",");
  const [answered, setAnswered] = useState<SuggestionState & Readonly<{ asked: string }>>({ ...NONE, asked: "" });
  useEffect(() => {
    if (asked === "") return undefined;
    const stop = new AbortController();
    void client.suggestion(asked.split(","), stop.signal).then((answer) => {
      if (stop.signal.aborted) return;
      if (answer.ok) setAnswered({ asked, suggestion: answer.data.suggestion, refusal: null });
      else setAnswered({ asked, suggestion: null, refusal: answer.status === 400 ? answer.refusal : null });
    });
    return () => stop.abort();
  }, [client, asked]);
  return answered.asked === asked ? { suggestion: answered.suggestion, refusal: answered.refusal } : NONE;
}
