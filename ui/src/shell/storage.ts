import { recall, remember } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";

/** The browser's `localStorage`, or null where it is refused (a private window, a blocked site): the shell works without it, it only forgets. */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** The names `ui.html` remembers a choice under, kept so a choice made there holds here. */
export const CONNECTION_MEMORY = "ticket-mode.connection";
export const PROJECT_MEMORY = "ticket-mode.project";

/** The one value remembered under `name`, or null. */
export const recalled = (storage: Storage | null, name: string): string | null => [...recall(storage, name)][0] ?? null;

/** Remember `value` as the one choice under `name`. */
export const remembered = (storage: Storage | null, name: string, value: string): void => remember(storage, name, new Set([value]));

/** A JSON value kept under `name`, or null when there is none, it cannot be read, or the storage is refused. */
export function recalledJson(storage: Storage | null, name: string): unknown {
  try {
    const saved = storage?.getItem(name) ?? null;
    return saved === null ? null : (JSON.parse(saved) as unknown);
  } catch {
    return null;
  }
}

/** Keep `value` as JSON under `name`, or forget it when it is null. A storage that refuses only forgets. */
export function rememberedJson(storage: Storage | null, name: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(name);
    else storage?.setItem(name, JSON.stringify(value));
  } catch {
    // storage refused: the page works without it
  }
}
