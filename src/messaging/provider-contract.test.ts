// @ts-check
// THE CONFORMANCE SUITE, AND PROOF THAT IT CAN FAIL (a11ign/a11ign#2900 done-when 5). Passing the fake provider proves little on its
// own -- a suite that accepts everything passes it too -- so each way a provider can be wrong is built here as a deliberately broken
// provider, and the suite must reject exactly that one and name the check.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ConformanceError, runProviderConformance } from "./provider-contract.ts";
import { FULL_CAPABILITIES, createFakeProvider } from "./fake-provider.ts";

/** @param {unknown} provider @returns {Promise<string[]>} the names of the checks that failed */
async function failedChecks(provider: unknown): Promise<string[]> {
  try {
    await runProviderConformance(provider);
  } catch (error) {
    assert.ok(error instanceof ConformanceError, `expected a ConformanceError, got ${error}`);
    return error.failures.map((failure: { check: any; }) => failure.check);
  }
  return [];
}

/** A provider with one behaviour broken, wrapping a working fake. @param {(real: any) => {id?: string, send?: (message: {text: string, silent?: boolean}) => Promise<unknown>, poll?: unknown, capabilities?: unknown, edit?: unknown, pin?: unknown}} override */
function broken(override: (real: any) => { id?: string; send?: (message: { text: string; silent?: boolean; }) => Promise<unknown>; poll?: unknown; capabilities?: unknown; edit?: unknown; pin?: unknown; }) {
  const real = createFakeProvider();
  return { ...real, ...override(real) };
}

test("the fake provider passes, and every check actually RAN (so 'passes' is not 'skipped everything')", async () => {
  const { passed, skipped } = await runProviderConformance(createFakeProvider());
  assert.deepEqual(skipped, []);
  assert.deepEqual(passed.sort(), [
    "actions-are-accepted", "announcement-refuses-actions", "announcement-reply-to-follows-its-destination", "audience-is-honoured",
    "capabilities-shape", "edit-changes-a-sent-message", "edit-refuses-empty-and-overlong-text",
    "empty-text-is-refused", "identity", "max-text-is-accepted-at-the-limit",
    "max-text-is-enforced", "message-refs-are-distinct", "pin-is-accepted", "poll-returns-updates-and-honours-abort", "reply-to-is-accepted",
    "send-returns-message-ref", "silent-is-honoured", "unknown-audience-is-refused",
  ]);
});

test("a provider that declares fewer capabilities passes, and the checks it is not asked for are skipped WITH a reason", async () => {
  const plain = createFakeProvider({ capabilities: { silent: false, buttons: false, replies: false, conversation: false } });
  const { passed, skipped } = await runProviderConformance(plain);
  assert.ok(passed.includes("silent-is-honoured"), "a provider that cannot be silent must say so, and is held to saying it");
  assert.deepEqual(skipped.map((entry) => entry.check).sort(), [
    "actions-are-accepted", "announcement-refuses-actions", "announcement-reply-to-follows-its-destination",
    "poll-returns-updates-and-honours-abort", "reply-to-is-accepted",
  ]);
  for (const entry of skipped) assert.match(entry.reason, /is not declared/);
});

test("a provider that declares neither edit nor pin passes, and their three checks are SKIPPED with the reason, never passed", async () => {
  const neither = createFakeProvider({ capabilities: { edit: false, pin: false } });
  const { passed, skipped } = await runProviderConformance(neither);
  const asked = ["edit-changes-a-sent-message", "edit-refuses-empty-and-overlong-text", "pin-is-accepted"];
  assert.deepEqual(skipped.map((entry) => entry.check).sort(), asked);
  assert.deepEqual(skipped.map((entry) => entry.reason).sort(), ["capabilities.edit is not declared", "capabilities.edit is not declared", "capabilities.pin is not declared"]);
  for (const check of asked) assert.equal(passed.includes(check), false, `${check} was skipped and must not also be a pass`);
  // A provider written before the two capabilities existed declares neither key at all, and is held to the same.
  const { edit, pin, ...older } = FULL_CAPABILITIES;
  assert.deepEqual((await runProviderConformance(broken(() => ({ capabilities: older })))).skipped.map((entry) => entry.check).sort(), asked);
});

test("FAILS a provider that declares edit and cannot, that says an edit changed nothing, or that names another message", async () => {
  assert.deepEqual(await failedChecks(broken(() => ({ edit: undefined }))), ["edit-changes-a-sent-message"]);
  const neverChanged = broken((real) => ({ edit: async (args: any) => ({ ...(await real.edit(args)), unchanged: true }) }));
  assert.deepEqual(await failedChecks(neverChanged), ["edit-changes-a-sent-message"]);
  const wrongRef = broken((real) => ({ edit: async (args: any) => ({ ...(await real.edit(args)), messageRef: "elsewhere" }) }));
  assert.deepEqual(await failedChecks(wrongRef), ["edit-changes-a-sent-message"]);
});

test("FAILS an edit that accepts empty or over-long text, and a pin that is missing or names another message", async () => {
  const lax = broken((real) => ({ edit: async ({ messageRef, text }: any) => (text === "" || text.length > real.capabilities.maxText ? { messageRef, unchanged: false } : real.edit({ messageRef, text })) }));
  assert.deepEqual(await failedChecks(lax), ["edit-refuses-empty-and-overlong-text"]);
  assert.deepEqual(await failedChecks(broken(() => ({ pin: undefined }))), ["pin-is-accepted"]);
  assert.deepEqual(await failedChecks(broken(() => ({ pin: async () => ({ messageRef: "elsewhere" }) }))), ["pin-is-accepted"]);
});

test("FAILS a declaration of edit or pin that is not a boolean", async () => {
  assert.ok((await failedChecks(broken(() => ({ capabilities: { ...FULL_CAPABILITIES, edit: "yes" } })))).includes("capabilities-shape"));
  assert.ok((await failedChecks(broken(() => ({ capabilities: { ...FULL_CAPABILITIES, pin: 1 } })))).includes("capabilities-shape"));
});

test("the fake provider's edit rewrites what the chairman would read, and its pin adds to the pinned list once", async () => {
  const fake = createFakeProvider();
  const { messageRef } = await fake.send({ text: "ask: publish?" });
  assert.deepEqual(await fake.edit({ messageRef, text: "✅ ask: publish? — published" }), { messageRef, unchanged: false });
  assert.equal(fake.sent[0].text, "✅ ask: publish? — published");
  assert.deepEqual(fake.edits, [{ messageRef, from: "ask: publish?", to: "✅ ask: publish? — published" }]);
  assert.deepEqual(await fake.edit({ messageRef, text: "✅ ask: publish? — published" }), { messageRef, unchanged: true });
  assert.equal(fake.edits.length, 1, "an edit that changed nothing is not recorded as one");
  await fake.pin({ messageRef });
  await fake.pin({ messageRef });
  assert.deepEqual(fake.pinned, [messageRef]);
  await assert.rejects(() => fake.edit({ messageRef: "fake-99", text: "x" }), RangeError);
  await assert.rejects(() => fake.pin({ messageRef: "fake-99" }), RangeError);
});

test("FAILS a provider that drops `silent`", async () => {
  const drops = broken((real) => ({ send: async (message) => ({ ...(await real.send({ ...message, silent: false })), silent: false }) }));
  assert.deepEqual(await failedChecks(drops), ["silent-is-honoured"]);
});

test("FAILS a provider that is silent when it was not asked to be", async () => {
  const always = broken((real) => ({ send: async (message) => ({ ...(await real.send(message)), silent: true }) }));
  assert.deepEqual(await failedChecks(always), ["silent-is-honoured"]);
});

test("FAILS a provider that ignores `maxText`", async () => {
  const ignores = broken((real) => ({ send: async (message) => ({ messageRef: `ref-${message.text.length}-${Math.random()}`, silent: real.capabilities.silent && message.silent === true }) }));
  const failed = await failedChecks(ignores);
  assert.ok(failed.includes("max-text-is-enforced"), `failed: ${failed}`);
  assert.equal(failed.includes("max-text-is-accepted-at-the-limit"), false, "it still delivers at the limit; only the refusal is missing");
});

test("FAILS a provider that returns no `messageRef`", async () => {
  const none = broken((real) => ({ send: async (message) => ({ silent: (await real.send(message)).silent }) }));
  const failed = await failedChecks(none);
  assert.ok(failed.includes("send-returns-message-ref"));
  assert.ok(failed.includes("message-refs-are-distinct"));
});

test("FAILS a provider that returns the same `messageRef` for two messages", async () => {
  // It declares neither edit nor pin: the fake can find no message called "always", and that is not the fault this test is about.
  const same = broken((real) => ({
    send: async (message) => ({ ...(await real.send(message)), messageRef: "always" }),
    capabilities: { ...FULL_CAPABILITIES, edit: false, pin: false },
  }));
  assert.deepEqual(await failedChecks(same), ["message-refs-are-distinct"]);
});

test("FAILS a provider that accepts an empty text", async () => {
  const accepts = broken((real) => ({ send: async (message) => message.text === "" ? { messageRef: "empty", silent: false } : real.send(message) }));
  assert.deepEqual(await failedChecks(accepts), ["empty-text-is-refused"]);
});

test("FAILS a provider that declares conversation and cannot poll, or whose poll ignores an aborted signal", async () => {
  const noPoll = broken(() => ({ poll: undefined }));
  assert.deepEqual(await failedChecks(noPoll), ["poll-returns-updates-and-honours-abort"]);
  const ignoresAbort = broken(() => ({ poll: () => new Promise(() => {}) }));
  assert.deepEqual(await failedChecks(ignoresAbort), ["poll-returns-updates-and-honours-abort"]);
});

test("FAILS a malformed declaration, and a value that is not a provider at all", async () => {
  assert.ok((await failedChecks(broken(() => ({ capabilities: { ...FULL_CAPABILITIES, maxText: 0 } })))).includes("capabilities-shape"));
  assert.ok((await failedChecks(broken(() => ({ capabilities: { ...FULL_CAPABILITIES, silent: "yes" } })))).includes("capabilities-shape"));
  assert.ok((await failedChecks(broken(() => ({ id: "" })))).includes("identity"));
  assert.deepEqual(await failedChecks({}), ["provider-object"]);
  assert.deepEqual(await failedChecks(null), ["provider-object"]);
});

test("one run reports EVERY way a provider is wrong, not just the first", async () => {
  const everything = broken(() => ({ send: async () => ({ messageRef: "same" }) }));
  const failed = await failedChecks(everything);
  for (const check of ["silent-is-honoured", "message-refs-are-distinct", "max-text-is-enforced", "empty-text-is-refused"]) {
    assert.ok(failed.includes(check), `${check} missing from ${failed}`);
  }
});
