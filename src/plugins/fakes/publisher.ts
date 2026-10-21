// @ts-check
// module: the in-memory publisher (A11-158) -- the reference that passes `runPublisherConformance`, and what core's tests use in place of Slack
//
// THE PUBLISH PROTOCOL IS CORE'S, NOT SLACK'S: the brief and the outcome reading (`publishBriefText`, `publishResult`) say nothing of a chat service, so the fake uses them
// and the contract suite holds them to it. What it records is what core asked: each brief it was asked for and each outcome it read.
import { publishResult } from "../../ticket-mode/pool-outcome.ts";
import { publishBriefText } from "../../ticket-mode/worker-files.ts";
import type { PublishedPull, Publisher, PublishResult } from "../contracts/publisher.ts";

export function createFakePublisher(connectors: readonly string[] = ["^mcp__fake_chat__"]) {
  const briefs: { dir: string; prs: readonly PublishedPull[]; run: string }[] = [];
  const results: PublishResult[] = [];
  const publisher: Publisher = {
    briefText(request) {
      briefs.push(request);
      return publishBriefText(request);
    },
    connectors: () => connectors,
    result(outcomeText, dir) {
      const result = publishResult(outcomeText, dir);
      results.push(result);
      return result;
    },
  };
  return Object.assign(publisher, { briefs, results });
}
