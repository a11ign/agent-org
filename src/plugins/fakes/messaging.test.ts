// no-token: none -- the fake messaging provider keeps what it was sent in memory
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConformanceError } from "../../messaging/provider-contract.ts";
import { runMessagingConformance } from "../conformance/messaging.ts";
import { createFakeMessaging } from "./messaging.ts";

test("the fake messaging provider passes the messaging contract suite, and what ran is asserted", async () => {
  const { passed, skipped } = await runMessagingConformance(createFakeMessaging());
  assert.ok(passed.length >= 5, `the suite ran its checks: ${passed.join(", ")}`);
  assert.deepEqual(skipped, [], "the fake has every capability, so nothing is skipped");
});

test("a provider that does not honour silent fails the messaging suite by name", async () => {
  const fake = createFakeMessaging();
  const noisy = { ...fake, send: async (message: Parameters<typeof fake.send>[0]) => ({ ...(await fake.send(message)), silent: false }) };
  await assert.rejects(runMessagingConformance(noisy), (error: unknown) => error instanceof ConformanceError && error.failures.length > 0);
});
