// no-token: none -- the publish run's protocol is files the suite writes into a scratch folder; no Slack is called, since the plugin posts nothing itself
//
// THE PUBLISHER CONTRACT'S SUITE, RUN ON THE SLACK PLUGIN (A11-161, Decision 11 of A11-157): `runPublisherConformance` is the only definition of "a publisher", so Slack passes the same checks the fake
// does. The plugin builds the brief and reads the outcome through `deps.publishing`, core's publish protocol, which the suite holds every publisher to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPublisherConformance } from "../../src/plugins/conformance/publisher.ts";
import { ContractError } from "../../src/plugins/conformance/suite.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { publishingHelpers } from "../../src/plugins/publishing-helpers.ts";
import { create } from "./index.ts";

const SETTINGS = { run: "Post these: {prs}. Write into {dir}.", connectors: ["^mcp__chat__send"] };
const CHECKS = [
  "shape", "briefText names every pull request and the run's folder", "connectors are patterns anchored at ^mcp__", "agent names the model and effort the run runs on", "result reads the links of a published run",
  "result reads a run that handed back as a failure with its reason", "result is a failure when the outcome cannot be read", "result is a failure for published with no links file",
];

test("the Slack publisher passes the publisher contract suite, and every check runs", async () => {
  const { passed, skipped } = await runPublisherConformance(create(SETTINGS, fakePluginDeps({ publishing: publishingHelpers() })));
  assert.deepEqual(passed, CHECKS);
  assert.deepEqual(skipped, []);
});

test("a Slack publisher with a connector not anchored at ^mcp__ fails the suite by name: the plugin offers the block's connectors as it holds them, and the suite is what refuses one", async () => {
  const publisher = create({ ...SETTINGS, connectors: ["mcp__chat__send"] }, fakePluginDeps({ publishing: publishingHelpers() }));
  await assert.rejects(runPublisherConformance(publisher), (error: unknown) => error instanceof ContractError && error.concern === "publisher" && error.failures.map(({ check }) => check).join() === "connectors are patterns anchored at ^mcp__");
});

test("a publisher built over helpers that do not follow the protocol fails the suite: the plugin is only as right as the protocol core hands it", async () => {
  const lenient = { ...publishingHelpers(), result: () => ({ links: [] }) };
  await assert.rejects(runPublisherConformance(create(SETTINGS, fakePluginDeps({ publishing: lenient }))), (error: unknown) => error instanceof ContractError
    && error.failures.map(({ check }) => check).join() === "result reads the links of a published run,result reads a run that handed back as a failure with its reason,result is a failure when the outcome cannot be read,result is a failure for published with no links file");
});
