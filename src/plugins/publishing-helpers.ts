// @ts-check
// module: what core hands a publisher plugin at run time (A11-161)
//
// A PLUGIN IMPORTS CORE'S TYPES ONLY (ADR 0001), so the publish protocol reaches a publisher through `deps.publishing`. THE PROTOCOL IS CORE'S, NOT SLACK'S: the brief (`publishBriefText`) and the
// reading of an outcome (`publishResult`) say nothing of a chat service, and the same functions are what the fake publisher and the contract suite use.
import { publishResult } from "../ticket-mode/pool-outcome.ts";
import { publishBriefText } from "../ticket-mode/worker-files.ts";
import type { PublishingHelpers } from "./manifest.ts";

/** The helpers a publisher plugin is given. */
export const publishingHelpers = (): PublishingHelpers => ({
  briefText: (request) => publishBriefText(request),
  result: (outcomeText, dir) => publishResult(outcomeText, dir),
});
