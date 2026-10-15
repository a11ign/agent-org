// no-token: gh -- the board is a fetch handed in, and the key a file in a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { pairingCode } from "./pair-command.ts";
import { parseTicketSettings } from "./settings.ts";

function machine() {
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: tmpDir("ticket-pair-"), tickets: { port: 4848 } });
  return { settings, key: boardKey(boardKeyPath(settings.stateDir)) };
}

test("ticket:pair asks this machine's board for a code with the key from its file", async () => {
  const { settings, key } = machine();
  const asked: { url: string; init?: RequestInit }[] = [];
  const answer = async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init });
    return new Response(JSON.stringify({ code: "ABCD-EFGH", minutes: 10 }), { status: 200 });
  };
  assert.deepEqual(await pairingCode(settings, answer as typeof fetch), { code: "ABCD-EFGH", minutes: 10 });
  assert.equal(asked[0].url, "http://127.0.0.1:4848/api/pair-code");
  assert.equal(asked[0].init?.method, "POST");
  assert.deepEqual(asked[0].init?.headers, { "x-ticket-token": key });
});

test("ticket:pair says so when no board is running, or the board refuses the key", async () => {
  const { settings } = machine();
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(pairingCode(settings, down as typeof fetch), /no board answers on 127\.0\.0\.1:4848: start it with agent-org ticket:serve/);
  const refuses = async () => new Response("{}", { status: 401 });
  await assert.rejects(pairingCode(settings, refuses as typeof fetch), /refused \(401\)/);
});

test("ticket:pair before any board has started says how to start one", async () => {
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: tmpDir("ticket-pair-none-") });
  await assert.rejects(pairingCode(settings, (async () => { throw new Error("not asked"); }) as typeof fetch), /does not exist: start the board once/);
});
