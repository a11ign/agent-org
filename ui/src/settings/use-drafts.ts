import { useEffect, useState } from "react";
import { clearCached, tabStorage } from "../api/session-cache.ts";
import type { Drafts } from "./settings-model.ts";

// Where `tabStorage` is refused (a private window, a blocked site), the drafts are kept for this page alone.

/** What a tab remembers of the changes staged for one instance, so moving between Models, Workers and Machine (a page load each) does not lose them. */
export const draftsKey = (connection: string): string => `ticket-mode.settings-drafts.${connection}`;

function recalled(key: string): Drafts {
  try {
    const stored: unknown = JSON.parse(tabStorage()?.getItem(key) ?? "{}");
    return typeof stored === "object" && stored !== null && !Array.isArray(stored) ? Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch {
    return {};
  }
}

function store(key: string, drafts: Drafts): void {
  if (Object.keys(drafts).length === 0) tabStorage()?.removeItem(key);
  else tabStorage()?.setItem(key, JSON.stringify(drafts));
}

/** What is typed comes before the answers the tab kept (A11-270): when the storage is full, those are dropped to make room, and a page reads them again. */
function remembered(key: string, drafts: Drafts): void {
  try {
    store(key, drafts);
  } catch {
    try {
      clearCached();
      store(key, drafts);
    } catch {
      // The drafts are still held by the page; only moving to another page forgets them.
    }
  }
}

export type DraftState = Readonly<{
  drafts: Drafts;
  /** Sets what a row's input says. */
  type: (id: string, text: string) => void;
  /** Takes the drafts of `ids` back, so those rows show what the file holds. */
  discard: (ids: readonly string[]) => void;
}>;

/** What has been typed into the rows of the instance `connection`, kept for the tab. The page is keyed by the connection, so another instance never shows these. */
export function useDrafts(connection: string): DraftState {
  const key = draftsKey(connection);
  const [drafts, setDrafts] = useState<Drafts>(() => recalled(key));
  // What is typed is kept for the tab as it changes.
  useEffect(() => remembered(key, drafts), [key, drafts]);
  return {
    drafts,
    type: (id, text) => setDrafts((before) => ({ ...before, [id]: text })),
    discard: (ids) => setDrafts((before) => Object.fromEntries(Object.entries(before).filter(([id]) => !ids.includes(id)))),
  };
}
