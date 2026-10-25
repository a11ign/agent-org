import { useEffect, useState } from "react";
import { ErrorState } from "../lifecycle/ErrorState.tsx";

/**
 * The banner of a failure: the server's sentence for an action it refused or a read that failed, with Retry and Dismiss, which hides that sentence until the next failure. An instance that cannot be
 * reached is the shared frame's instead, above the last good list. A `title` heads the sentence, for the one the page says is a failed publish.
 */
export function FailureBanner({ sentence, title, onRetry, onDismiss }: Readonly<{ sentence: string | null; title?: string; onRetry: () => void; onDismiss: () => void }>) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (sentence === null) setDismissed(null);
  }, [sentence]);
  if (sentence === null || sentence === dismissed) return null;
  return <ErrorState refusal={sentence} title={title} onRetry={onRetry} onDismiss={() => { onDismiss(); setDismissed(sentence); }} />;
}
