/**
 * The suite's `fetch` stays off the network (`offline-fetch.ts`). The library is read with a fake real `fetch`. The LIVE tests read this worker's own
 * `fetch` and a Node process started from it, because "every test is offline" is a claim about the config and the setup, which no unit test makes.
 */
// no-token: gh -- nothing here calls `gh`, and no `fetch` here leaves the machine
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GITHUB_STATUS_URL as GATE_STATUS_URL, githubIncidentOf } from "./work-gate.ts";
import { CALM_GITHUB_STATUS, GITHUB_STATUS_URL, offlineFetch } from "./offline-fetch.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_PATH = join(REPO, "scripts", "rstest", "rstest.config.ts");
const config: { setupFiles?: string[] } | undefined = existsSync(CONFIG_PATH) ? (await import(pathToFileURL(CONFIG_PATH).href)).default : undefined;
const liveSkip = config === undefined ? "scripts/rstest/rstest.config.ts is not laid out beside this file"
  : process.env.NODE_OPTIONS?.includes("offline-fetch-preload.ts") ? undefined : "this run is not agent-org's own rstest config, whose setup preloads the offline fetch";

/** A real `fetch` that records what reached it and answers 204. */
function recorder() {
  const reached: string[] = [];
  const real = (async (input: RequestInfo | URL) => {
    reached.push(String(input instanceof Request ? input.url : input));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { real, reached };
}

test("the status URL is the gate's own, and the calm page reads as clear", () => {
  assert.equal(GITHUB_STATUS_URL, GATE_STATUS_URL);
  assert.equal(githubIncidentOf({ status: 200, body: JSON.stringify(CALM_GITHUB_STATUS) }).state, "clear");
});

test("loopback and data: reach the real fetch, the status page answers calm without it, and anything else is refused as a dropped network", async () => {
  const { real, reached } = recorder();
  const offline = offlineFetch(real);
  for (const url of ["http://127.0.0.1:4747/api/queue", "http://localhost:9/x", "http://[::1]:80/", "data:application/json,{}"]) {
    assert.equal((await offline(url)).status, 204, url);
  }
  const status = await offline(new URL(GITHUB_STATUS_URL));
  assert.deepEqual(await status.json(), CALM_GITHUB_STATUS);
  for (const url of ["https://api.typesafe.ai/v1/systemone", "https://api.github.com/graphql", "http://127.0.0.2/", "https://www.githubstatus.com/history"]) {
    await assert.rejects(offline(url), (err: Error) => err instanceof TypeError && err.message === "fetch failed" && /the network is off in tests/.test((err.cause as Error).message), url);
  }
  await assert.rejects(offline(new Request("https://example.com/a?token=secret")), (err: Error) => (err.cause as Error).message === "the network is off in tests: https://example.com/a",
    "the refusal names where, and never a query string");
  assert.equal(reached.length, 4, "only the four let through reached the real fetch");
});

test("LIVE: the config runs the offline setup after the private TMPDIR, this worker's fetch is offline, and so is a Node process it starts",
  { skip: liveSkip }, async () => {
    assert.deepEqual(config?.setupFiles?.slice(0, 2), ["src/private-tmp-setup.ts", "src/offline-setup.ts"]);
    await assert.rejects(fetch("https://example.com/"), /fetch failed/);
    const child = spawnSync(process.execPath, ["-e", "fetch('https://example.com/').then(() => console.log('reached'), (e) => console.log(e.cause.message))"], { encoding: "utf8" });
    assert.equal(child.stdout.trim(), "the network is off in tests: https://example.com/", child.stderr);
  });
