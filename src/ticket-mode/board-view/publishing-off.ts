// @ts-check
// module: what a run says about publishing on a machine whose publisher is switched off, by the same rule that offers Publish (PURE)
import { publishable, type ViewPublish } from "./pull-status-and-notes.ts";
import type { PublishWhen } from "./publish-when.ts";
import { PUBLISHING_OFF_LINE } from "./pull-review-state.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

/** What the board reads of the queue to decide Publish: the publish run if there is one, and when this machine publishes (absent from an older instance, which publishes at Ready to merge). */
export type Publishing = Readonly<{ publish?: ViewPublish; publishWhen?: PublishWhen }>;

/**
 * The one line a run says about publishing: "publishing off" for a run that would be offered for Publish (`publishable`, by the machine's `when`) on a machine whose publisher is installed and disabled
 * (`off`). A machine with no publisher (`none`) shows nothing extra, and one whose publisher is on has its Publish controls instead. `publisher` is `/api/config`'s `publisher` state.
 */
export function publishingOffLine(entry: ViewEntry, publishing: Publishing, publisher: string | undefined): string | null {
  return publisher === "off" && publishable(entry, publishing.publish, publishing.publishWhen) ? PUBLISHING_OFF_LINE : null;
}
