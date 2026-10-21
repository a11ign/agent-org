// @ts-check
// module: what core hands a messaging plugin at run time (A11-162)
//
// A PLUGIN IMPORTS CORE'S TYPES ONLY (ADR 0001), so the secret by reference, the fetch that cannot leak it and the chairman's ids reach a messaging plugin through `deps.messaging`. They are
// the same functions every core reader of those files calls, so a file refused for its mode is refused by the plugin in the same words.
import type { MessagingHelpers } from "../plugins/manifest.ts";
import { readAnnouncementsChatId, readChairman } from "./state.ts";
import { readSecretFile, redactingFetch, secretFileProblem } from "./secret.ts";

/** The helpers a messaging plugin is given. `sleep` is the caller's clock, when it has injected one. */
export const messagingHelpers = (sleep?: (ms: number) => Promise<void>): MessagingHelpers => ({
  redactingFetch, readSecretFile: (path) => readSecretFile(path), secretFileProblem: (path) => secretFileProblem(path), readChairman, readAnnouncementsChatId, ...(sleep === undefined ? {} : { sleep }),
});
