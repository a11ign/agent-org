// no-token: none -- pure functions over strings, and a stand-in for `tailscale` that answers from a list; no tailscale runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedTailnetName, parseServeStatus, parseStatus, portState, readTailnetName, refused, removeArgv, serveArgv, serveStatusArgv, statusArgv, TAILSCALE_MISSING, tailnetHosts, tailnetOrigins, tailnetTerminal, type TailscaleResult } from "./tailnet.ts";

const status = (over: Record<string, unknown> = {}) => JSON.stringify({ BackendState: "Running", Self: { DNSName: "agents.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7", "fd7a::7"] }, ...over });

/** The agents host's serve config as read on 2026-10-17: Funnel on :443 for `/webhook`, a plain serve on :8443. */
const AGENTS_HOST = JSON.stringify({
  TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
  Web: {
    "agents.tail1234.ts.net:443": { Handlers: { "/webhook": { Proxy: "http://127.0.0.1:8787" } } },
    "agents.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8788" } } },
  },
  AllowFunnel: { "agents.tail1234.ts.net:443": true },
});

test("the status is read from Self: its DNS name without the trailing dot and lower-cased, its first address, and whether it is Running", () => {
  assert.deepEqual(parseStatus(status()), { running: true, state: "Running", name: "agents.tail1234.ts.net", ip: "100.64.0.7" });
  const upper = JSON.stringify({ BackendState: "Running", Self: { DNSName: "Agents.Tail1234.ts.net." } });
  assert.equal(parseStatus(upper)?.name, "agents.tail1234.ts.net");
  assert.equal(parseStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "bad name!.ts.net." } }))?.name, null, "a name outside [a-z0-9.-] is no name");
  assert.equal(parseStatus(JSON.stringify({ BackendState: "Running" }))?.name, null, "no Self: no name");
  assert.equal(parseStatus(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "a.ts.net." } }))?.running, false);
  assert.equal(parseStatus("tailscale is not running"), null, "text that is not JSON is no status");
});

test("the name is read through `tailscale status --json`, and none is given when the call fails", () => {
  const answer = (result: TailscaleResult) => readTailnetName(() => result);
  assert.equal(answer({ status: 0, stdout: status(), stderr: "" }), "agents.tail1234.ts.net");
  assert.equal(answer({ status: 1, stdout: status(), stderr: "failed" }), null);
  assert.equal(answer({ status: null, stdout: "", stderr: "spawnSync tailscale ENOENT" }), null);
});

test("serve and remove are built for one port each, and no builder names funnel or reset", () => {
  assert.deepEqual(serveArgv(9443, 4748), ["serve", "--bg", "--https=9443", "http://127.0.0.1:4748"]);
  assert.deepEqual(removeArgv(9443), ["serve", "--https=9443", "off"]);
  assert.deepEqual(statusArgv(), ["status", "--json"]);
  assert.deepEqual(serveStatusArgv(), ["serve", "status", "--json"]);
  for (const argv of [serveArgv(9443, 4748), removeArgv(9443), statusArgv(), serveStatusArgv()]) {
    assert.ok(!argv.some((word) => /funnel/i.test(word)), `${argv.join(" ")} names funnel`);
    assert.ok(!argv.includes("reset"), `${argv.join(" ")} resets the whole serve config`);
  }
});

test("the agents host's serve config reads as its entries: the :443 Funnel, and :8443 plain", () => {
  const entries = parseServeStatus(AGENTS_HOST);
  assert.ok(entries);
  assert.deepEqual(portState(entries, "agents.tail1234.ts.net", 443, 8787), { kind: "foreign", proxy: null, funnel: true });
  assert.deepEqual(portState(entries, "agents.tail1234.ts.net", 8443, 8788), { kind: "ours", proxy: "http://127.0.0.1:8788", funnel: false });
  assert.deepEqual(parseServeStatus(""), { web: {}, funnel: {} }, "empty output is an empty config");
  assert.equal(parseServeStatus("not json"), null);
});

test("a port is free, this board's own, foreign, or on Funnel, against the loopback service it should proxy to", () => {
  const name = "agents.tail1234.ts.net";
  const free = parseServeStatus("{}");
  assert.ok(free);
  assert.deepEqual(portState(free, name, 9443, 4748), { kind: "free", proxy: null, funnel: false });
  const ours = parseServeStatus(JSON.stringify({ Web: { [`${name}:9443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4748" } } } } }));
  assert.ok(ours);
  assert.equal(portState(ours, name, 9443, 4748).kind, "ours");
  assert.equal(portState(ours, name, 9443, 4749).kind, "foreign", "the same port proxying to another loopback port is not this board's");
  const extra = parseServeStatus(JSON.stringify({ Web: { [`${name}:9443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4748" }, "/x": { Proxy: "http://127.0.0.1:9" } } } } }));
  assert.ok(extra);
  assert.equal(portState(extra, name, 9443, 4748).kind, "foreign", "an extra handler is another entry");
  const funnelOnOurs = parseServeStatus(JSON.stringify({ Web: { [`${name}:9443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4748" } } } }, AllowFunnel: { [`${name}:9443`]: true } }));
  assert.ok(funnelOnOurs);
  assert.deepEqual(portState(funnelOnOurs, name, 9443, 4748), { kind: "ours", proxy: "http://127.0.0.1:4748", funnel: true });
});

test("the Host and Origin values the board answers to on the tailnet name the public port, and the bare name only at 443", () => {
  assert.deepEqual(tailnetHosts({ name: "agents.tail1234.ts.net", port: 9443 }), ["agents.tail1234.ts.net:9443"]);
  assert.deepEqual(tailnetHosts({ name: "agents.tail1234.ts.net", port: 443 }), ["agents.tail1234.ts.net:443", "agents.tail1234.ts.net"]);
  assert.deepEqual(tailnetOrigins({ name: "agents.tail1234.ts.net", port: 9443 }), ["https://agents.tail1234.ts.net:9443"]);
  assert.deepEqual(tailnetOrigins({ name: "agents.tail1234.ts.net", port: 443 }), ["https://agents.tail1234.ts.net:443", "https://agents.tail1234.ts.net"]);
});

test("the terminal address on the tailnet is the one a board link opens, with the run's placeholders kept", () => {
  assert.equal(tailnetTerminal({ name: "agents.tail1234.ts.net", port: 9444 }), "https://agents.tail1234.ts.net:9444/?ws={workspace}&pane={pane}&view=terminal");
});

test("a refused serve call names the operator fix, and any other failure is its own first line with the command", () => {
  const args = serveArgv(9443, 4748);
  const denied: TailscaleResult = { status: 1, stdout: "", stderr: "Access denied: serve config denied\nmore detail" };
  assert.equal(refused(denied, args, "alice"),
    "`tailscale serve --bg --https=9443 http://127.0.0.1:4748` was refused for alice, who is not the operator of this machine's Tailscale: run `sudo tailscale set --operator=alice`, then start the service again");
  assert.equal(refused({ status: 1, stdout: "", stderr: "tailscaled is not running\nsecond line" }, statusArgv(), "alice"), "`tailscale status --json` failed: tailscaled is not running");
  assert.equal(refused({ status: null, stdout: "", stderr: "spawnSync tailscale ENOENT" }, args, "alice"), TAILSCALE_MISSING);
});

test("the name is read once it is read, and asked again no sooner than ten seconds after a failure", async () => {
  let clock = 0;
  const answers: (string | null)[] = [null, "agents.tail1234.ts.net"];
  let asked = 0;
  const name = cachedTailnetName(async () => { asked++; return answers.shift() ?? null; }, () => clock);
  assert.equal(await name(), null, "the first read finds none");
  assert.equal(await name(), null, "a read within ten seconds is not asked again");
  assert.equal(asked, 1);
  clock = 9_999;
  assert.equal(await name(), null);
  assert.equal(asked, 1);
  clock = 10_000;
  assert.equal(await name(), "agents.tail1234.ts.net", "after ten seconds the read is asked again, and finds the name");
  clock = 1_000_000;
  assert.equal(await name(), "agents.tail1234.ts.net");
  assert.equal(asked, 2, "a name found once is kept, and is not read again");
});
