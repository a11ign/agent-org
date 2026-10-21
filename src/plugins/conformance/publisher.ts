// @ts-check
// module: the publisher contract's suite (A11-158) -- `runPublisherConformance(publisher)` is the only definition of "a publisher"
//
// THE SEAM IS THE PUBLISH RUN'S PROTOCOL: the brief names each pull request and the run's folder, the run writes `published.json` (`PUBLISHED_FILE`) with the links of
// the messages it posted, and the outcome file says it `published` or needs a person. The suite drives the protocol with fixtures it writes into a scratch folder.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLISHED_FILE, type Publisher } from "../contracts/publisher.ts";
import { type ConformanceResult, expect, hasFunctions, isString, runChecks } from "./suite.ts";

const OPERATIONS = ["briefText", "connectors", "agent", "result"] as const;
const PULLS = [{ repo: "owner/one", url: "https://github.com/owner/one/pull/1" }, { repo: "owner/two", url: "https://github.com/owner/two/pull/2" }];

/** Runs `use` with a scratch folder standing for the run's, and removes it. */
async function withRun(use: (dir: string) => unknown): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "publisher-conformance-"));
  try {
    await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALWAYS: Readonly<Record<string, (publisher: Publisher) => unknown>> = {
  "briefText names every pull request and the run's folder": (publisher) => withRun((dir) => {
    const text = publisher.briefText({ dir, prs: PULLS, run: "Post these: {prs}. Write into {dir}." });
    expect(isString(text), "briefText must be text");
    for (const { url } of PULLS) expect(text.includes(url), `the brief must name ${url}`);
    expect(text.includes(dir), "the brief must name the run's folder, where it writes its links");
    expect(!text.includes("{prs}") && !text.includes("{dir}"), "the brief must fill {prs} and {dir} in the instruction");
  }),
  "connectors are patterns anchored at ^mcp__": (publisher) => {
    const connectors = publisher.connectors();
    expect(Array.isArray(connectors) && connectors.every((pattern) => isString(pattern) && pattern.startsWith("^mcp__")), "connectors() must be a list of patterns anchored at \"^mcp__\"");
    for (const pattern of connectors) new RegExp(pattern);
  },
  "agent names the model and effort the run runs on": (publisher) => {
    const { model, effort } = publisher.agent();
    expect(isString(model) && model !== "" && isString(effort) && effort !== "", "agent() must name a model and an effort, each a non-empty word");
  },
  "result reads the links of a published run": (publisher) => withRun((dir) => {
    writeFileSync(join(dir, PUBLISHED_FILE), JSON.stringify({ links: ["https://example.invalid/message/1"] }));
    const result = publisher.result(JSON.stringify({ kind: "published" }), dir);
    expect(JSON.stringify(result) === JSON.stringify({ links: ["https://example.invalid/message/1"] }), "result of a published run must be { links }");
  }),
  "result reads a run that handed back as a failure with its reason": (publisher) => withRun((dir) => {
    const result = publisher.result(JSON.stringify({ kind: "needs-human", reason: "the channel is archived" }), dir);
    expect("failure" in result && result.failure === "the channel is archived", "result of a needs-human run must be { failure: its reason }");
  }),
  "result is a failure when the outcome cannot be read": (publisher) => withRun((dir) => {
    expect("failure" in publisher.result("not json", dir), "result of an unreadable outcome must be a failure, not links");
  }),
  "result is a failure for published with no links file": (publisher) => withRun((dir) => {
    expect("failure" in publisher.result(JSON.stringify({ kind: "published" }), dir), "result of published with no links file must be a failure: nothing says what was posted");
  }),
};

/**
 * Runs every check against `publisher`, so one run reports EVERY way a publisher is wrong.
 * @throws ContractError listing each failed check
 */
export function runPublisherConformance(publisher: Publisher): Promise<ConformanceResult> {
  return runChecks("publisher", publisher, {
    shape: (candidate) => expect(hasFunctions(candidate, OPERATIONS), `a publisher is an object with ${OPERATIONS.join(", ")} functions`),
    always: ALWAYS,
  });
}
