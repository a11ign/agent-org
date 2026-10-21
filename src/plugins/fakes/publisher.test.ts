// no-token: none -- the fake publisher reads outcome files the suite writes into a scratch folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPublisherConformance } from "../conformance/publisher.ts";
import { ContractError } from "../conformance/suite.ts";
import type { Publisher } from "../contracts/publisher.ts";
import { PUBLISHED_FILE } from "../contracts/publisher.ts";
import { PUBLISHED_FILE as CORE_PUBLISHED_FILE } from "../../ticket-mode/worker-files.ts";
import { createFakePublisher } from "./publisher.ts";

test("the fake publisher passes the publisher contract suite, and the checks that ran are the ones asserted", async () => {
  const { passed, skipped } = await runPublisherConformance(createFakePublisher());
  assert.deepEqual(passed, [
    "shape", "briefText names every pull request and the run's folder", "connectors are patterns anchored at ^mcp__", "result reads the links of a published run",
    "result reads a run that handed back as a failure with its reason", "result is a failure when the outcome cannot be read", "result is a failure for published with no links file",
  ]);
  assert.deepEqual(skipped, []);
});

test("the contract names the file core's brief tells the run to write", () => {
  assert.equal(PUBLISHED_FILE, CORE_PUBLISHED_FILE);
});

test("a publisher that reads a published run with no links as links fails by name", async () => {
  const fake = createFakePublisher();
  const published = (text: string): boolean => /"published"/.test(text);
  const trusting: Publisher = { ...fake, result: (text, dir) => (published(text) ? { links: [] } : fake.result(text, dir)) };
  await assert.rejects(runPublisherConformance(trusting), (error: unknown) => error instanceof ContractError && error.concern === "publisher"
    && error.failures.map(({ check }) => check).join() === "result reads the links of a published run,result is a failure for published with no links file");
});

test("a publisher whose connector pattern is not anchored at ^mcp__ fails by name", async () => {
  await assert.rejects(runPublisherConformance(createFakePublisher(["mcp__slack__send"])), (error: unknown) => error instanceof ContractError
    && error.failures.map(({ check }) => check).join() === "connectors are patterns anchored at ^mcp__");
});

test("the fake records the briefs it was asked for and the results it read", async () => {
  const fake = createFakePublisher();
  await runPublisherConformance(fake);
  assert.equal(fake.briefs.length, 1);
  assert.equal(fake.results.length, 4);
});
