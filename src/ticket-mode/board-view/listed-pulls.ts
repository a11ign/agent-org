// @ts-check
// module: the open pull requests a run's outcome or approval names (PURE), apart from the ones it opened itself (A11-358)
import { openPulls } from "./view-types-and-filters.ts";

/**
 * The run's open pull requests that its outcome or its approval names, without the ones it opened itself (A11-358): what a person approved, and so what a review run may mark ready, and what a run lost in a restart had on record. PURE.
 */
export function listedOpenPulls<T extends Readonly<{ url: string }>>(entry: Readonly<{ outcome?: Readonly<{ kind: string; prs?: readonly T[] }>; review?: readonly T[]; pullStates?: Readonly<Record<string, string>> }>): T[] {
  return openPulls({ outcome: entry.outcome, review: entry.review, pullStates: entry.pullStates });
}
