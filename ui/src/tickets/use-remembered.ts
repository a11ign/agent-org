import { useCallback, useState } from "react";
import { recall, remember, toggled } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { browserStorage } from "../shell/storage.ts";

/** The names `ui.html` remembers the Pick list's choices under, kept so a choice made there holds here. */
export const OPEN_MEMORY = "ticket-mode.open";
export const OPEN_PARENTS_MEMORY = "ticket-mode.open-parents";
export const PRIORITIES_MEMORY = "ticket-mode.priorities";
export const PLAN_MEMORY = "ticket-mode.plan";
export const LABELS_MEMORY = "ticket-mode.labels";

/** A set of strings remembered in this browser under `name`: what it holds now, how to replace it, and how to take one value in or out. A browser that refuses storage just forgets it. */
export type Remembered = Readonly<{ values: ReadonlySet<string>; replace: (next: ReadonlySet<string>) => void; toggle: (value: string) => void }>;

export function useRemembered(name: string): Remembered {
  const [values, setValues] = useState<ReadonlySet<string>>(() => recall(browserStorage(), name));
  const replace = useCallback((next: ReadonlySet<string>) => {
    setValues(next);
    remember(browserStorage(), name, next);
  }, [name]);
  const toggle = useCallback((value: string) => replace(toggled(values, value)), [values, replace]);
  return { values, replace, toggle };
}
