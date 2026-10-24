import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { BatchOverride } from "./tickets-model.ts";

/** The batch's queue options as the page holds them, and how they change. */
export type BatchState = Readonly<{
  override: BatchOverride;
  planFirst: boolean;
  setOverride: Dispatch<SetStateAction<BatchOverride>>;
  setPlanFirst: (next: boolean) => void;
}>;

/** The tickets ticked for the next Queue, by key. */
export type Selection = Readonly<{
  selected: ReadonlySet<string>;
  /** Ticks `keys`. */
  pick: (keys: readonly string[]) => void;
  /** Unticks `keys`. */
  unpick: (keys: readonly string[]) => void;
  clear: () => void;
}>;

export function useSelection(): Selection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const pick = useCallback((keys: readonly string[]) => setSelected((before) => new Set([...before, ...keys])), []);
  const unpick = useCallback((keys: readonly string[]) => setSelected((before) => new Set([...before].filter((key) => !keys.includes(key)))), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  return { selected, pick, unpick, clear };
}

/** The queue options of the next batch: the model and effort it differs from the default in, and whether Plan first is ticked, which it starts as. */
export function useBatch(): BatchState {
  const [override, setOverride] = useState<BatchOverride>({});
  const [planFirst, setPlanFirst] = useState(true);
  return { override, planFirst, setOverride, setPlanFirst };
}
