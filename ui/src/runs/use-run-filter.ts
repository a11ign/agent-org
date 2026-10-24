import { useState } from "react";
import { remember } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import type { RunStatus } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { browserStorage, recalled } from "../shell/storage.ts";
import { FILTER_MEMORY, filterFrom } from "./runs-model.ts";

/** The status the rail has chosen (null is All runs), and how to choose another. */
export type RunFilter = Readonly<{ filter: RunStatus | null; choose: (status: RunStatus | null) => void }>;

/** The rail's choice, remembered in this browser under the name `ui.html` uses, so a choice made there holds here. A browser that refuses storage just forgets it. */
export function useRunFilter(): RunFilter {
  const [filter, setFilter] = useState<RunStatus | null>(() => filterFrom(recalled(browserStorage(), FILTER_MEMORY)));
  return {
    filter,
    choose: (status) => {
      setFilter(status);
      remember(browserStorage(), FILTER_MEMORY, new Set(status === null ? [] : [status]));
    },
  };
}
