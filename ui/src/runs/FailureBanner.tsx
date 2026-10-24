import { useEffect, useState } from "react";
import { ErrorState } from "../lifecycle/ErrorState.tsx";

/**
 * The banner of a failure: the server's sentence for an action it refused or a read that failed, with Retry and Dismiss, which hides that sentence until the next failure. An instance that cannot be
 * reached is the shared frame's instead, above the last good list.
 */
export function FailureBanner({ sentence, onRetry, onDismiss }: Readonly<{ sentence: string | null; onRetry: () => void; onDismiss: () => void }>) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (sentence === null) setDismissed(null);
  }, [sentence]);
  if (sentence === null || sentence === dismissed) return null;
  return <ErrorState refusal={sentence} onRetry={onRetry} onDismiss={() => { onDismiss(); setDismissed(sentence); }} />;
}
