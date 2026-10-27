// module: what the Publish boards say and when they are drawn -- which runs can be ticked, which header button a run gets, the boards' fixed words -- as pure functions of the queue the shell reads
//
// THE RULE IS board-view's. `publishable` decides which runs can be published, `isBeingPublished` which are held by the publish run under way, and `publishLabel`, `publishNote` and `publishTerminalLink` word them; this
// file only adds the machine's gate (`/api/config`'s `publish`) and the words the five Publish boards draw. No channel is named: the backend holds none to name (`configView` sends only whether the machine publishes).
import { isBeingPublished, publishable, publishNote, shownStatus, type ViewPublish } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import type { Publishing as BoardPublishing } from "../../../src/ticket-mode/board-view/publishing-off.ts";
import type { ConfigView, QueueView } from "../api/types.ts";
import type { RunEntry } from "./runs-model.ts";

// ---- The boards' words ----

/** The Publish button's tooltip on a run a person can publish, and the disabled one's on a run the publish run is already posting. */
export const PUBLISH_TITLE = "Post this pull request. Nothing is merged: a person still merges.";
export const PUBLISHING_TITLE = "A publish run is already posting this pull request";

/** The sentence beside "Open #N on GitHub" on the Ready, Publishing and Published boards. */
export const PUBLISH_MERGE_NOTE = "A person merges. Publish posts this pull request.";
export const PUBLISHING_MERGE_NOTE = "A person merges. Publishing does not merge anything.";
export const PUBLISHED_MERGE_NOTE = "A person merges. Nothing was merged by publishing.";

/** The heading of the banner that carries a refused or failed publish. */
export const NOT_PUBLISHED = "Not published.";

/** The selection bar's sentence, beside "N selected". */
export const SELECTION_NOTE = "Posts their pull requests. Nothing is merged.";

/** The title of the link to a published run's Slack message, `ui.html`'s words. */
export const MESSAGE_TITLE = "Open the Slack message";

/** The tooltip of the Publishing board's link to the publish run's session. */
export const PUBLISH_TERMINAL_TITLE = "Opens the publish run's session in herdr";

// ---- When Publish is drawn ----

/** Whether this machine has a publisher (`tickets.publish` in the host file), which is the only thing that draws a Publish control. A config not yet read draws none. */
export const showsPublish = (config: Pick<ConfigView, "publish"> | null): boolean => config?.publish === true;

/** The header button of a run: Publish when a person can publish it, Publish disabled while the publish run under way is posting it, and none for any other run. */
export type PublishState = "publish" | "publishing";

/** What the Publish rules read of the queue: the runs, beside the publish run and when this machine publishes (`Publishing`, board-view's). */
type Publishing = BoardPublishing & Readonly<{ entries: QueueView["entries"] }>;

/** The Publish button a run's header draws, or null. PURE. */
export function publishState(entry: RunEntry, queue: Publishing): PublishState | null {
  if (publishable(entry, queue.publish, queue.publishWhen)) return "publish";
  return shownStatus(entry, queue.publish, queue.entries) === "publishing" && isBeingPublished(entry, queue.publish) ? "publishing" : null;
}

/** The ticked keys that can still be published: a run that is no longer publishable, was dismissed or is now held by a publish run drops out, as `ui.html` prunes its ticks on every read. Order is kept. PURE. */
export function prunePicked(picked: readonly string[], queue: Publishing): string[] {
  const open = new Set(queue.entries.filter((entry) => publishable(entry, queue.publish, queue.publishWhen)).map((entry) => entry.ticket.key));
  return picked.filter((key) => open.has(key));
}

/** The keys with `key` ticked when it was not, else without it. PURE. */
export const toggled = (picked: readonly string[], key: string): string[] => (picked.includes(key) ? picked.filter((candidate) => candidate !== key) : [...picked, key]);

/**
 * The publisher's reason for a publish run that finished and failed, as `publishNote` words it ("Publishing 1 run failed: ..."), or null. With a `key`, only when that run was one of the run's keys, so
 * a run's page does not carry the failure of a publish it was not in.
 */
export function failedPublishSentence(queue: Readonly<{ publish?: ViewPublish }>, key?: string): string | null {
  const { publish } = queue;
  if (publish === undefined || publish.phase !== "finished" || publish.failure === undefined) return null;
  if (key !== undefined && !publish.keys.includes(key)) return null;
  return publishNote(publish);
}
