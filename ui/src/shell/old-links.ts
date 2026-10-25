// module: where an address of the old board lands on Atomaut (A11-202)
//
// THE OLD BOARD WAS ONE PAGE AT `/`, and what a link named was in its query and its anchor: `?connection=<name>` chose the instance, `#run-<KEY>` scrolled to a run's card, `#writer-<id>` to a
// request's card, and `#/settings` was the Settings page. Atomaut has a page for each, so `/` sends on to the one a link meant. The anchor is read in the browser: a server never sees it.
import { runsHref, settingsHref, ticketsHref } from "./routes.ts";

/** What an anchor names, decoded: `run-A11-1`, `/settings`, or empty for no anchor, or one that is not a valid encoding (it named nothing, as it named no card on the old board). */
function anchorOf(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return "";
  }
}

/**
 * The address the old board's `search` and `hash` mean, with the query carried whole (`?connection=` among it): a run's own page for `#run-<KEY>`, Models for `#/settings`, and Tickets for the rest.
 * A request card has no address of its own (the request strip is on Tickets), so `#writer-<id>` lands on Tickets without its anchor. An anchor that names nothing the old board had is kept, since a link
 * to a place on Tickets may use it. PURE.
 */
export function oldLinkTarget(search: string, hash: string): string {
  const anchor = anchorOf(hash);
  const run = /^run-(.+)$/.exec(anchor)?.[1];
  if (run !== undefined) return `${runsHref}/${encodeURIComponent(run)}${search}`;
  if (anchor === "/settings") return `${settingsHref}${search}`;
  if (anchor.startsWith("writer-")) return `${ticketsHref}${search}`;
  return `${ticketsHref}${search}${hash}`;
}
