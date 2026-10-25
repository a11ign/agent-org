// no-token: none -- the host file is built and read in memory; no process starts and no file is written
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureHost, captureName, CaptureRefusal, HERDR_STUB, parseRoute, parseSize, pngSize, READY_SELECTOR, routeAddress, routeSlug } from "./capture.ts";
import { parseTicketSettings, readTicketSettings } from "./settings.ts";

const FACTS = { checkout: "/work/agent-org", stateDir: "/tmp/cap/state", binDir: "/tmp/cap/bin", port: 47901, uiPort: 47902, keyPath: "/tmp/cap/linear-key" };

test("the throwaway host file loads through the settings reader, with the two ports, a local exposure and the state folder it names", () => {
  const host = captureHost(FACTS);
  // The reader is the one the instance uses, so a key renamed in either breaks this test rather than a capture.
  const settings = parseTicketSettings(host, "/home/me");
  assert.equal(settings.port, 47901);
  assert.equal(settings.uiPort, 47902);
  assert.equal(settings.stateDir, "/tmp/cap/state");
  assert.equal(settings.binDir, "/tmp/cap/bin", "no gh wrapper is written to the real bin folder");
  assert.deepEqual(settings.clones, { "agent-org": "/work/agent-org" });
  assert.deepEqual(settings.providers.blocks.tracker.settings.key.value, { path: "/tmp/cap/linear-key" });
  assert.equal(settings.providers.blocks.exposure.provider, "local", "a local exposure serves on loopback, never the tailnet");
  assert.equal(settings.terminal, null, "no worker terminal is linked from a throwaway board");
});

test("the throwaway host file is read by readTicketSettings from the path the environment names", () => {
  const text = JSON.stringify(captureHost(FACTS));
  const settings = readTicketSettings({ AGENT_ORG_HOST: "/tmp/cap/host.json" }, () => text, "/home/me");
  assert.equal(settings.uiPort, 47902);
});

test("the two ports the throwaway host uses must differ, and the reader refuses the host file when they do not", () => {
  assert.throws(() => parseTicketSettings(captureHost({ ...FACTS, uiPort: FACTS.port }), "/home/me"), /must differ/);
});

test("a size is WIDTHxHEIGHT in whole pixels, and anything else is refused by name", () => {
  assert.deepEqual(parseSize("1280x800"), { width: 1280, height: 800 });
  for (const bad of ["0x0", "1280", "abc", "1280x0", "-1x800", "1280x800px", "99999x800"]) {
    assert.throws(() => parseSize(bad), (err: Error) => err instanceof CaptureRefusal && err.message.includes("--size must be WIDTHxHEIGHT"), bad);
  }
});

test("a route is a plain path of the board, and anything else is refused", () => {
  assert.equal(parseRoute("/settings"), "/settings");
  assert.equal(parseRoute("/"), "/");
  for (const bad of ["settings", "https://example.com/", "/settings?x=1", "/a b"]) {
    assert.throws(() => parseRoute(bad), CaptureRefusal, bad);
  }
});

test("a capture's file is named for its route and size, so two sizes of one route do not overwrite each other", () => {
  assert.equal(routeSlug("/settings"), "settings");
  assert.equal(routeSlug("/"), "board");
  assert.equal(routeSlug("/ticket/A11-151/"), "ticket-A11-151");
  assert.equal(captureName("/settings", { width: 1280, height: 800 }), "settings-1280x800.png");
  assert.notEqual(captureName("/settings", { width: 1280, height: 800 }), captureName("/settings", { width: 390, height: 844 }));
});

test("A11-202: the address opens the route's own path on the board, and a page has drawn once its heading is in the page's column", () => {
  assert.equal(routeAddress(4748, "/settings"), "http://127.0.0.1:4748/settings");
  assert.equal(routeAddress(4748, "/runs/A11-151"), "http://127.0.0.1:4748/runs/A11-151");
  assert.equal(routeAddress(4748, "/"), "http://127.0.0.1:4748/");
  assert.throws(() => routeAddress(4748, "/settings?x=1"), CaptureRefusal);
  assert.equal(READY_SELECTOR, "main .shell-page h1");
});

test("a PNG's size is read from its header, and bytes that are not a PNG have none", () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(pngSize(png), { width: 1280, height: 800 });
  assert.equal(pngSize(Buffer.from("not a png at all, really not a png")), null);
  const notIhdr = Buffer.from(png);
  notIhdr.write("JUNK", 12, "latin1");
  assert.equal(pngSize(notIhdr), null);
});

test("the herdr stub answers the instance's workspace question with none, and exits 0 for anything else", () => {
  assert.match(HERDR_STUB, /workspace list/);
  assert.match(HERDR_STUB, /"workspaces":\[\]/);
  assert.match(HERDR_STUB, /exit 0/);
});
