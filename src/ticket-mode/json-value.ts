// @ts-check
// module: the two reads of a parsed JSON value the Settings page, its readers' verdicts and its edits all share: an object's test, and the value at a path
//
// IMPORTS NOTHING, so the page's view (`settings-view.ts`) loads it on a ticket-only machine, as it loads nothing else from the readers.

/** Whether `value` is a JSON object: not null, not a list, and not a scalar. */
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at `path` in `root`, or undefined: one step per segment, never through a list. */
export function valueAt(root: unknown, path: readonly string[]): unknown {
  let at = root;
  for (const segment of path) {
    if (!isObject(at)) return undefined;
    at = at[segment];
  }
  return at;
}
