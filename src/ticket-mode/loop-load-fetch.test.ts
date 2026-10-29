// no-token: none -- the script runs in a child of this Node with the preload and asks api.linear.app, which the preload answers from 127.0.0.1 itself: nothing leaves this machine
// A11-282: the network of the load script's throwaway instance. The tracker's `freshFetch` (`src/fresh-fetch.ts`) opens its connection with `node:https` and never saw the suite's offline `fetch`, so the instance's tracker reads went to the
// internet with a placeholder key, and the script timed that round trip (300 ms) instead of the instance. The preload refuses at once, from this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "loop-load-fetch.ts");
/** What the child prints: the status and body of the tracker's own transport, of the global `fetch`, and of a loopback server the preload must leave alone. */
const PROGRAM = `
import { createServer } from "node:http";
import { freshFetch } from ${JSON.stringify(new URL("../fresh-fetch.ts", import.meta.url).href)};
const local = createServer((_request, response) => { response.end("loopback"); }).listen(0, "127.0.0.1");
await new Promise((done) => local.once("listening", done));
const started = performance.now();
const tracker = await freshFetch("https://api.linear.app/graphql", { method: "POST", body: "{}" });
const global = await fetch("https://api.linear.app/graphql", { method: "POST", body: "{}" });
const loopback = await freshFetch("http://127.0.0.1:" + local.address().port + "/");
const viaOptions = await new Promise((done) => import("node:https").then(({ request }) => request({ hostname: "api.github.com", path: "/user", method: "GET" }, (response) => done(response.statusCode)).end()));
const plain = await new Promise((done) => import("node:http").then(({ request }) => request("http://example.com/x", (response) => done(response.statusCode)).end()));
console.log(JSON.stringify({ tracker: [tracker.status, await tracker.text()], global: [global.status, await global.text()], loopback: await loopback.text(), viaOptions, plain, ms: performance.now() - started }));
local.close();
`;

test("A11-282: the tracker's transport, a request made with options, plain http and the global fetch are refused by an answer from this machine, and loopback goes through", () => {
  const ran = spawnSync(process.execPath, ["--import", PRELOAD, "--input-type=module", "-e", PROGRAM], { encoding: "utf8", timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr);
  const said = JSON.parse(ran.stdout) as { tracker: [number, string]; global: [number, string]; loopback: string; viaOptions: number; plain: number; ms: number };
  assert.deepEqual(said.tracker.map(String), ["401", JSON.stringify({ errors: [{ message: "loop-load: the network is off" }] })], "freshFetch's request never left this machine");
  assert.deepEqual(said.global, said.tracker.map((part, at) => (at === 0 ? Number(part) : part)), "and the global fetch gets the same refusal");
  assert.equal(said.loopback, "loopback", "a loopback server is not refused");
  assert.deepEqual([said.viaOptions, said.plain], [401, 401], "a request given its address as options, and a plain http one, are refused too");
  assert.ok(said.ms < 2_000, `answered in ${Math.round(said.ms)} ms: a refusal is not a dropped connection, which the tracker would try three times over 3 s`);
});
