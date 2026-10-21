// @ts-check
// module: whether a machine's reviewer and publisher are on, off or none, as the board says it (A11-161) (PURE)
//
// "NONE" IS THE ABSENCE OF AN ENABLED PLUGIN, and the board says something about it only where the machine said it matters. A reviewer that is off on a machine where reviews are REQUIRED is
// a warning (a banner, and each open pull request waiting on it); one that is off where they are not is nothing, since people review there. A publisher that is installed and DISABLED hides the
// Publish buttons and says "publishing off" on a run that is ready to merge; a machine with no publisher at all shows nothing extra. The pool and the server both ask here, so one rule is said once.
import type { Catalog } from "../plugins/manifest.ts";
import { pluginsOfConcern } from "../plugins/registry.ts";
import type { Providers } from "./providers.ts";
import type { TicketSettings } from "./settings.ts";

/**
 * Whether this machine's reviewer is on: `on` when a reviewer plugin is active (and starts here, or only waits for drafts to be marked ready); `off-required` when reviews are required and
 * there is none (no plugin, a disabled one, or one that refuses to start here); `none` when it is not required and there is none, and nothing extra is shown anywhere.
 */
export type ReviewerState = "on" | "off-required" | "none";

/**
 * The state of the reviewer. `refusal` is why the active reviewer cannot start here, or null: asked only of a machine that starts reviewers, since the gate is not loaded for one whose
 * `drafts` is on.
 */
export function reviewerStateOf(settings: Pick<TicketSettings, "reviewer" | "reviewerRequired">, refusal: string | null): ReviewerState {
  const off: ReviewerState = settings.reviewerRequired ? "off-required" : "none";
  if (settings.reviewer === null) return off;
  return refusal === null ? "on" : off;
}

/** Whether this machine publishes: `on`, `off` when a publisher plugin is installed and disabled, or `none` when it names none. */
export type PublisherState = "on" | "off" | "none";

export function publisherStateOf(settings: Pick<TicketSettings, "publish" | "providers">): PublisherState {
  if (settings.publish !== null) return "on";
  const { provider, enabled } = settings.providers.blocks.publish;
  return provider !== "none" && !enabled ? "off" : "none";
}

/**
 * The command that puts a reviewer back: `agent-org plugin enable <name>` when the reviewer block names a plugin (it is installed, and disabled), else `agent-org plugin install <name>` of the
 * catalog's bundled reviewer. What doctor and `ticket:review` say when there is none.
 */
export function enableReviewerCommand(providers: Providers, catalog: Catalog): string {
  const { provider } = providers.blocks.reviewer;
  if (provider !== "none") return `agent-org plugin enable ${provider}`;
  const bundled = pluginsOfConcern(catalog, "reviewer").find(({ where }) => where === "bundled");
  return bundled === undefined ? "agent-org plugin list" : `agent-org plugin install ${bundled.name}`;
}
