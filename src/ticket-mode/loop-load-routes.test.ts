// no-token: gh -- the source is read off disk, and the one server is a stand-in on 127.0.0.1; no instance starts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRounds, ROUTES } from "../../scripts/loop-load.ts";

const TICKET_MODE = dirname(fileURLToPath(import.meta.url));

/** Every `GET /api/*` path the instance's route modules answer, read from their source: `method === "GET" && path === "…"`, and a module's own `method !== "GET" || path !== "…"`. */
function getRoutesInSource(): Set<string> {
  const files = readdirSync(TICKET_MODE, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const found = new Set<string>();
  for (const file of files) {
    const text = readFileSync(join(TICKET_MODE, file), "utf8");
    for (const match of text.matchAll(/method (?:===|!==) "GET" (?:&&|\|\|) path (?:===|!==) "(\/api\/[^"]+)"/g)) found.add(match[1]);
  }
  return found;
}

test("the load script reads every GET route the instance answers, and no route it does not", () => {
  const inSource = getRoutesInSource();
  assert.ok(inSource.has("/api/config") && inSource.has("/api/people"), `the source scan finds the routes: ${[...inSource].join(", ")}`);
  const read = new Set(ROUTES.map((route) => route.split("?")[0]));
  assert.deepEqual([...inSource].filter((route) => !read.has(route)), [], "a route the script does not time");
  assert.deepEqual([...read].filter((route) => !inSource.has(route)), [], "a route the instance does not answer");
  assert.ok(ROUTES.some((route) => route.startsWith("/api/tickets?assignee=")), "the Assignee scope's page of /api/tickets, its own branch of the route");
});

test("no round starts after the read phase's time is up, so an instance that holds every read still ends the run", async () => {
  const server = createServer((_request, response) => { setTimeout(() => response.end("{}"), 300); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  try {
    const started = Date.now();
    const { rounds, routes } = await readRounds(port, { rounds: 20, forMs: 500 });
    assert.ok(rounds >= 1 && rounds <= 2, `${rounds} rounds`);
    assert.ok(Date.now() - started < 3_000, "the run ended soon after its time was up");
    assert.equal(routes.length, ROUTES.length);
    assert.ok(routes.every((route) => route.p50Ms >= 250), "each read was timed as the stand-in held it");
  } finally {
    await new Promise<void>((done) => { server.close(() => done()); });
  }
});
