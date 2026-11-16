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

/** What reading a JSON value back says: nothing is kept under the name, the value kept, or why it could not be read (the browser refused, or what is kept is not JSON). */
export type Recalled = Readonly<{ kind: "absent" }> | Readonly<{ kind: "kept"; value: unknown }> | Readonly<{ kind: "unreadable"; reason: string }>;

/** Why nothing can be kept or read: the browser refuses the page its storage (a private window, a blocked site). */
export const STORAGE_REFUSED = "this browser refuses to keep anything for this page";

const ABSENT: Recalled = { kind: "absent" };
const unreadable = (reason: string): Recalled => ({ kind: "unreadable", reason });
const reasonOf = (error: unknown): string => (error instanceof Error && error.message !== "" ? error.message : STORAGE_REFUSED);

/** The JSON value kept under `name`, told apart from no value and from a value that cannot be read. */
export function recalledJson(storage: Storage | null, name: string): Recalled {
  if (storage === null) return unreadable(STORAGE_REFUSED);
  let saved: string | null;
  try {
    saved = storage.getItem(name);
  } catch (error) {
    return unreadable(reasonOf(error));
  }
  if (saved === null) return ABSENT;
  try {
    return { kind: "kept", value: JSON.parse(saved) as unknown };
  } catch {
    return unreadable(`what this browser kept under ${name} is not JSON`);
  }
}

/** Keeps `value` as JSON under `name`, or forgets it when it is null: the reason when the browser refused, else null. */
export function rememberedJson(storage: Storage | null, name: string, value: unknown): string | null {
  if (storage === null) return STORAGE_REFUSED;
  try {
    if (value === null) storage.removeItem(name);
    else storage.setItem(name, JSON.stringify(value));
    return null;
  } catch (error) {
    return reasonOf(error);
  }
}
