import type { TicketView } from "../api/types.ts";
import { Sections, type SectionsContext } from "./Sections.tsx";
import { sectionsOf } from "./tickets-model.ts";
import type { WorkspaceSearch } from "./use-workspace-search.ts";

/** "3 open tickets elsewhere in the tracker": how many matches the list does not hold. */
export const elsewhereText = (count: number): string => `${count} open ${count === 1 ? "ticket" : "tickets"} elsewhere in the tracker`;

/**
 * The search's matches the list does not hold (A11-378): open tickets of the whole workspace, whoever holds them and whatever their project, each a row that names its owner and project and
 * can be opened and queued as a listed one can. Its sections are always open, and nothing is drawn when every match is listed already.
 */
export function SearchResults({ search, listed, context }: Readonly<{ search: WorkspaceSearch; listed: readonly TicketView[]; context: SectionsContext }>) {
  if (search.searching) return <div role="status" className="filter-note">Searching the tracker…</div>;
  if (search.refusal !== null) return <div role="alert" className="section-empty">The tracker could not be searched: {search.refusal}</div>;
  const keys = new Set(listed.map(({ key }) => key));
  const outside = search.results.filter(({ key }) => !keys.has(key));
  if (outside.length === 0) return null;
  const sections = sectionsOf(outside, outside, []);
  const always = { ...context, open: new Set(sections.map(({ status }) => status)), toggleSection: () => undefined, row: { ...context.row, showsOwner: true } };
  return (
    <section aria-label="Elsewhere in the tracker" className="search-results">
      <div className="section-label">{elsewhereText(outside.length)}</div>
      <Sections sections={sections} context={always} />
    </section>
  );
}
