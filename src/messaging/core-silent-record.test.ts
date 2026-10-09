// @ts-check
// "WAS IT SILENT" IS ANSWERABLE FROM THE LEDGER (a11ign/a11ign#3385). `provider.send` returns the `silent` it APPLIED, and `attemptSend`
// used to drop it, so a `summary:` line (meant to be silent) was byte-for-byte the shape of a `request:` line (meant to ring).
//
// Every case reads the LEDGER FILE, never the provider's own `sent` list, because the ledger is the record the question is asked of.
// Each fails on an `attemptSend` that writes no `silent` key, which is the positive control the row names.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createMessenger } from "./core.mjs";
import { createFakeProvider } from "./fake-provider.ts";
import { createLedger, readLedgerLines } from "./ledger.mjs";

const START = Date.parse("2026-10-04T09:00:00Z");
const scratch = mkdtempSync(join(tmpdir(), "messaging-silent-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/** @param {{ send?: (message: any) => Promise<any> }} [override] replaces the fake provider's `send`, to model a provider that misreports */
async function sendThrough(/** @type {Record<string, any>[]} */ events: Record<string, any>[], override: { send?: (message: any) => Promise<any>; } = {}) {
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  const provider = { ...createFakeProvider(), ...override };
  const messenger = createMessenger({ provider, ledger: createLedger({ path, now: () => START }), now: () => START });
  await messenger.tick(events);
  return readLedgerLines(path);
}

const summary = { key: "summary:2026-10-03", kind: "summary", severity: "info", firstSeenAt: START, text: "Daily summary", links: [] };
const ask = { key: "request:a11ign/a11ign#1", kind: "request", severity: "warning", firstSeenAt: START, text: "row 1 needs the chairman", links: [] };

describe("a sent ledger line records the silent flag the provider applied (#3385 done-when 1)", () => {
  test("a summary is recorded silent: true and a request silent: false", async () => {
    const [summaryLine] = await sendThrough([summary]);
    const [requestLine] = await sendThrough([ask]);
    assert.equal(summaryLine.status, "sent");
    assert.equal(summaryLine.silent, true);
    assert.equal(requestLine.status, "sent");
    assert.equal(requestLine.silent, false);
  });

  test("a provider that returns no silent is recorded null, never false", async () => {
    const [line] = await sendThrough([summary], { send: async () => ({ messageRef: "bare-1" }) });
    assert.equal(line.status, "sent");
    assert.ok(Object.hasOwn(line, "silent"), "the key is present so a reader never has to tell absent from unrecorded");
    assert.equal(line.silent, null);
  });

  test("a provider that DROPS the flag is recorded as what it applied, not what was asked", async () => {
    /** @type {any[]} */
    const asked: any[] = [];
    const [line] = await sendThrough([summary], { send: async (message) => { asked.push(message); return { messageRef: "loud-1", silent: false }; } });
    assert.equal(asked[0].silent, true, "the core DID ask for silent: the control that the record differs from the request");
    assert.equal(line.silent, false);
  });

  test("a failed send carries no silent: nothing was applied", async () => {
    const [line] = await sendThrough([summary], { send: async () => { throw new Error("network down"); } });
    assert.equal(line.status, "failed");
    assert.equal(Object.hasOwn(line, "silent"), false);
  });
});
