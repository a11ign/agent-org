// @ts-check
// module: when a machine's runs can be published, `tickets.providers.publish.when` -- the values the reader accepts and `publishable` reads (PURE, a leaf: it imports nothing, so the settings reader can name it)
//
// `ready-to-merge`, the default, publishes once a reviewer approved the pull requests, so the post announces work that can merge. `awaiting-review` is for a machine where people review: the post is how a
// reviewer finds the pull request, so a run can be published once its only wait is review.

export const PUBLISH_WHEN = ["ready-to-merge", "awaiting-review"] as const;
export type PublishWhen = (typeof PUBLISH_WHEN)[number];
export const DEFAULT_PUBLISH_WHEN: PublishWhen = "ready-to-merge";
