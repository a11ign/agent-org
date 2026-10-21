// no-token: none -- reads project.json files the test writes into a scratch folder, and no file they name
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { messagingStateOf, messagingStateOfFile } from "./messaging-state.ts";

function projectWith(text: string): string {
  const path = join(tmpDir("messaging-state-"), "project.json");
  writeFileSync(path, text);
  return path;
}

test("the provider the project's messaging key names is the state, and nothing it points at is opened", async () => {
  const project = projectWith(JSON.stringify({ messaging: { provider: "telegram", tokenFile: "/nonexistent/token", chairmanFile: "/nonexistent/chairman" } }));
  assert.deepEqual(await messagingStateOf({}, project), { provider: "telegram" });
});

test("no messaging key is off, a key that names no provider says so, and a file that cannot be read says why", async () => {
  assert.deepEqual(await messagingStateOf({}, projectWith("{}")), { provider: null, why: "project.json has no messaging key, so messaging is off" });
  assert.deepEqual(await messagingStateOf({}, projectWith(JSON.stringify({ messaging: {} }))), { provider: null, why: "project.json's messaging key names no provider" });
  const unreadable = await messagingStateOf({}, join(tmpDir("messaging-state-"), "missing.json"));
  assert.equal(unreadable.provider, null);
  assert.match("why" in unreadable ? unreadable.why : "", /^project\.json could not be read: /);
});

test("a ticket-only host declares no project, so messaging is not configured on it, and an unreadable host file says so", async () => {
  const host = join(tmpDir("messaging-state-"), "host.json");
  writeFileSync(host, JSON.stringify({ clones: { app: "/tmp/app" }, tickets: {} }));
  assert.deepEqual(await messagingStateOfFile(host), { provider: null, why: "this machine declares no project, so messaging is not configured" });
  const missing = await messagingStateOfFile(join(tmpDir("messaging-state-"), "absent.json"));
  assert.match("why" in missing ? missing.why : "", /the host file .*absent\.json cannot be read, so project\.json is not found/);
});
