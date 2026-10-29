import { useEffect, useRef, useState } from "react";
import type { WritersView } from "../api/types.ts";
import { arrivedOf, underWayOf } from "./notifications-model.ts";

type Runs = WritersView["runs"];

/**
 * The requests that finished while this page was open: each was seen under way and is now finished, so it is new to the person. This is the page's memory only: a page that first sees a
 * request finished marks nothing, so a reload does, and nothing is stored or sent. `onArrive` is called once a read brings new ones.
 */
export function useArrivals(runs: Runs, onArrive: () => void): ReadonlySet<string> {
  const underWay = useRef<ReadonlySet<string>>(new Set());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const arrived = arrivedOf(underWay.current, runs);
    underWay.current = underWayOf(runs);
    if (arrived.length === 0) return;
    setFresh((before) => new Set([...before, ...arrived]));
    onArrive();
  }, [runs, onArrive]);
  return fresh;
}
