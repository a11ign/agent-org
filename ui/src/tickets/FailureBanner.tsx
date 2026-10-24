import { useEffect, useState } from "react";
import { ErrorState } from "../lifecycle/ErrorState.tsx";
import { useShell } from "../shell/ShellProvider.tsx";

/**
 * The banner of a failure: the server's sentence for an action it refused (`refusal`), else for a read that failed, with Retry reading again and Dismiss hiding it until the next
 * failure. An instance that cannot be reached is the shell's frame instead, above the last good list.
 */
export function FailureBanner({ refusal, clearRefusal }: Readonly<{ refusal: string | null; clearRefusal: () => void }>) {
  const { tickets } = useShell();
  const sentence = refusal ?? (tickets.state === "error" ? tickets.refusal : null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (sentence === null) setDismissed(null);
  }, [sentence]);
  if (sentence === null || sentence === dismissed) return null;
  return <ErrorState refusal={sentence} onRetry={() => { clearRefusal(); tickets.refresh(); }} onDismiss={() => { clearRefusal(); setDismissed(sentence); }} />;
}
