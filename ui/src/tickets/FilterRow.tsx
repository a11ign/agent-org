import { useShell } from "../shell/ShellProvider.tsx";
import { AssigneeGroup, FilterMenu, SearchBox } from "./FilterBar.tsx";
import { segmentsOf } from "./tickets-model.ts";
import type { FilterState, ListView } from "./use-tickets-page.ts";

type FilterRowProps = Readonly<{ filters: FilterState; list: ListView }>;

/** The filter row: the search box, the Assignee group where the instance names assignees, and the dashed Priority, Plan and label buttons. */
export function FilterRow({ filters, list }: FilterRowProps) {
  const { config, chooseScope, readingScope } = useShell();
  const segments = list.source === null ? [] : segmentsOf(list.source);
  return (
    <div className="filter-row">
      <SearchBox value={filters.filters.search} onChange={filters.setSearch} />
      {config?.viewer === undefined ? null : <AssigneeGroup segments={segments} signedIn={config.viewer !== null} onChoose={chooseScope} />}
      {readingScope === null ? null : <span role="status" className="filter-note">Loading…</span>}
      {list.menus.map((menu) => <FilterMenu key={menu.id} menu={menu} onChoose={(itemId) => filters.choose(menu, itemId)} />)}
    </div>
  );
}
