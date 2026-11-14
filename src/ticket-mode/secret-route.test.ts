// no-token: none -- a real `createBoard` over a scratch host file, with the tracker, the code host and the pool injected; the plugins' checks are a stand-in module
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { PluginModule } from "../plugins/manifest.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { readJson } from "./local-http.ts";
import { createBoard } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";

const TOKEN = "lin_api_feedfacecafeROUTE";
const LINEAR = defaultCatalog().plugins.find(({ name }) => name === "linear")!;

/** A board over a scratch home whose host file names the Linear key's file, with a linear plugin whose check says whether the file holds a key. */
function board() {
  const home = tmpDir("secret-route-");
  const agentOrgHome = join(home, ".agent-org");
  mkdirSync(agentOrgHome, { recursive: true });
  const keyFile = join(agentOrgHome, "linear.key");
  const hostPath = join(agentOrgHome, "host.json");
  const host = { clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: join(home, "state"), tickets: { providers: { tracker: { provider: "linear", enabled: true, key: { path: keyFile } }, codeHost: { provider: "github", enabled: true } } } };
  writeFileSync(hostPath, JSON.stringify(host));
  const doctorChecks = () => {
    try {
      return [{ name: "tracker key", ok: readFileSync(keyFile, "utf8").trim() !== "", detail: "a key is in the file" }];
    } catch {
      return [{ name: "tracker key", ok: false, detail: "no key file" }];
    }
  };
  const settings = parseTicketSettings(host);
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, stop: () => {}, close: async () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: async () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: async () => {} };
  const made = createBoard({ settings, source: createFakeTracker([]), codeHost: createFakeCodeHost(), key: "a".repeat(48), queuePath: join(home, "queue.json"), choicePath: join(home, "choice.json"), pool, version: null, next: () => null, hostPath,
    plugins: { load: async () => ({ loaded: [], unbuilt: [{ plugin: LINEAR, module: { doctorChecks } as unknown as PluginModule }], refusals: [] }), messaging: { state: async () => ({ provider: null, why: "off" }), checks: async () => [] },
      version: "v1.2.3", log: () => undefined, secrets: { home, agentOrgHome, platform: "linux", security: async () => ({ status: 0, stdout: "", stderr: "" }) } } });
  return { made, keyFile };
}

/** What the instance writes on its stderr (its log) while `work` runs. */
async function stderrOf<T>(work: () => Promise<T>): Promise<{ value: T; log: string }> {
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { value: await work(), log: written.join("") };
  } finally {
    process.stderr.write = write;
  }
}

test("A11-445: POST /api/plugins/secret stores the secret and answers the plugin's check, and neither the answer, the plugins read after it nor the instance's log carries it", async () => {
  const { made, keyFile } = board();
  const { value: [status, answer], log } = await stderrOf(() => made.api("POST", "/api/plugins/secret", { name: "linear", setting: "key.path", value: TOKEN, base: "" }));
  assert.equal(status, 200);
  assert.equal(readFileSync(keyFile, "utf8"), `${TOKEN}\n`);
  assert.deepEqual((answer as { checks: unknown }).checks, [{ name: "tracker key", ok: true, detail: "a key is in the file" }]);
  const [, read] = await made.api("GET", "/api/plugins", {});
  for (const [what, text] of [["the answer", JSON.stringify(answer)], ["the plugins read", JSON.stringify(read)], ["the log", log]]) assert.equal(text.includes(TOKEN), false, `${what} does not carry it`);
});

test("A11-445: a refused secret is a 400 with the refusal, which names its shape and never the value", async () => {
  const { made } = board();
  const [status, answer] = await made.api("POST", "/api/plugins/secret", { name: "linear", setting: "key.path", value: `${TOKEN} extra` });
  assert.equal(status, 400);
  assert.match((answer as { error: string }).error, /one line with no space/);
  assert.equal(JSON.stringify(answer).includes(TOKEN), false);
});

test("A11-445: a request body that is not JSON is refused in words of its own, never with JSON.parse's quote of the text around the fault", async () => {
  const request = Readable.from([Buffer.from(`{"value": ${TOKEN}}`)]) as unknown as IncomingMessage;
  await assert.rejects(readJson(request, 1024), (error: Error) => {
    assert.equal(error.message, "a request body must be valid JSON");
    return true;
  });
});
