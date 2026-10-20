// @ts-check
// module: the Settings page's search -- which rows a query leaves: each group's rows whose key or explanation contains the query, ignoring case
//
// A PLAIN SUBSTRING, NEVER A PATTERN: the query is matched as text, so a typed `(` is a character and not an error. An empty query leaves every group and row.
//
// SENT TO THE BROWSER AS IT IS, LIKE `label-filters.ts`: `ui-server.ts` serves it as `/settings-search.js` with the types stripped. So it imports
// nothing and uses no Node API. PURE throughout, and tested without a browser.

/** The part of a settings row a search reads: its name and what it says. */
export type Searchable = Readonly<{ key: string; explanation: string }>;

/** A group of settings rows, as the Settings page draws it. */
export type Searched<T extends Searchable> = Readonly<{ group: string; rows: readonly T[] }>;

/** The groups as the query leaves them, in their order: every group stays, holding only the rows that match. */
export function searchGroups<T extends Searchable>(groups: readonly Searched<T>[], query: string): Searched<T>[] {
  if (query === "") return [...groups];
  const wanted = query.toLowerCase();
  const matches = (row: Searchable) => row.key.toLowerCase().includes(wanted) || row.explanation.toLowerCase().includes(wanted);
  return groups.map(({ group, rows }) => ({ group, rows: rows.filter(matches) }));
}
