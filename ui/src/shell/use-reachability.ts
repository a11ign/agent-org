import { useEffect, useRef, useState } from "react";

/**
 * What the shell knows of whether the connection it shows can be reached, beyond the sentence: `reconnected` is true once it has been unreachable and is not now (the Tickets board's
 * "reached over SSH again" banner), and stays true until the connection is switched, which gives the shell new reads. `onRecover` is called on the change from unreachable to reached,
 * so the reads made once per connection (the tickets, the config) are read again and the page returns to live data.
 */
export function useReachability(unreachable: string | null, onRecover: () => void): Readonly<{ reconnected: boolean }> {
  const [wasDown, setWasDown] = useState(false);
  const before = useRef<string | null>(null);
  const recover = useRef(onRecover);
  useEffect(() => {
    recover.current = onRecover;
  });
  useEffect(() => {
    if (unreachable !== null) setWasDown(true);
    else if (before.current !== null) recover.current();
    before.current = unreachable;
  }, [unreachable]);
  return { reconnected: wasDown && unreachable === null };
}
