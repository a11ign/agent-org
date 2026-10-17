// no-token: gh -- the key is a file in a temporary directory; nothing is run
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { remoteInfo } from "./remote-info-command.ts";
import { parseTicketSettings } from "./settings.ts";

const settingsWith = (tickets: Record<string, unknown>) => parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: tmpDir("ticket-remote-info-"), tickets });

test("ticket:remote-info gives another machine's board this board's port, key and terminal address", () => {
  const settings = settingsWith({ port: 4848, terminal: "http://127.0.0.1:7318/?ws={workspace}" });
  const key = boardKey(boardKeyPath(settings.stateDir));
  assert.deepEqual(remoteInfo(settings, false), { port: 4848, key, terminal: "http://127.0.0.1:7318/?ws={workspace}" });
  assert.equal(remoteInfo(settingsWith({}), false, () => key).terminal, null);
});

test("ticket:remote-info refuses to print the key to a terminal, and refuses a board that has no key yet", () => {
  const settings = settingsWith({});
  boardKey(boardKeyPath(settings.stateDir));
  assert.throws(() => remoteInfo(settings, true), /refuses to print it to a terminal/);
  assert.throws(() => remoteInfo(settingsWith({}), false), /does not exist: start the instance once with agent-org ticket:serve/);
});
