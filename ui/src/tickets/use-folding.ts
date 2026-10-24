import { everythingOpen, parentsOf } from "./tickets-model.ts";
import { OPEN_MEMORY, OPEN_PARENTS_MEMORY, useRemembered } from "./use-remembered.ts";
import type { ListView } from "./use-tickets-page.ts";

/** Opens or closes every section and parent, and remembers them as `ui.html`'s Expand all does. */
export function useFolding(list: ListView) {
  const open = useRemembered(OPEN_MEMORY);
  const openParents = useRemembered(OPEN_PARENTS_MEMORY);
  const allOpen = everythingOpen(list.sections, open.values, openParents.values);
  const foldAll = () => {
    openParents.replace(allOpen ? new Set() : new Set([...openParents.values, ...parentsOf(list.sections)]));
    open.replace(allOpen ? new Set() : new Set([...open.values, ...list.sections.map(({ status }) => status)]));
  };
  return { open: open.values, openParents: openParents.values, toggleSection: open.toggle, toggleParent: openParents.toggle, allOpen, foldAll };
}
