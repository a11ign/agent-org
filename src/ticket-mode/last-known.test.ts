// no-token: gh -- the store is a temporary directory and a clock the test moves
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createLastKnown, lastKnownDir, MOST_PATHS, REWRITE_AFTER_MS, WRITE_GAP_MS } from "./last-known.ts";

const TICKETS = [{ key: "A11-1", title: "one" }];
const AGENTS = "agents";
const OPENED_AT = Date.parse("2026-10-24T10:00:00.000Z");

test("an answer is recalled with the time it was read, and a new store on the same directory recalls the same", () => {
  const dir = lastKnownDir(tmpDir("last-known-"));
  const first = createLastKnown(dir, { now: () => OPENED_AT });
  assert.equal(first.recall("personal", AGENTS, "/api/tickets"), undefined, "nothing was read yet");
  first.remember("personal", AGENTS, "/api/tickets", TICKETS);
  assert.deepEqual(first.recall("personal", AGENTS, "/api/tickets"), { value: TICKETS, readAt: "2026-10-24T10:00:00.000Z" });
  const restarted = createLastKnown(dir);
  assert.deepEqual(restarted.recall("personal", AGENTS, "/api/tickets"), { value: TICKETS, readAt: "2026-10-24T10:00:00.000Z" }, "it survives a restart");
  assert.equal(restarted.recall("work", AGENTS, "/api/tickets"), undefined, "one connection's answer is not another's");
  assert.equal(restarted.recall("personal", AGENTS, "/api/queue"), undefined, "nor one path's another's");
});

test("an answer read from another ssh target is not recalled, so a connection pointed at another host shows nothing of the old one", () => {
  const dir = lastKnownDir(tmpDir("last-known-"));
  createLastKnown(dir).remember("personal", AGENTS, "/api/tickets", TICKETS);
  const repointed = createLastKnown(dir);
  assert.equal(repointed.recall("personal", "me@elsewhere", "/api/tickets"), undefined);
  assert.deepEqual(repointed.recall("personal", AGENTS, "/api/tickets")?.value, TICKETS);
});

test("the file is private to its owner, in a private directory, one file per connection", () => {
  const dir = lastKnownDir(tmpDir("last-known-"));
  const store = createLastKnown(dir);
  store.remember("personal", AGENTS, "/api/tickets", TICKETS);
  store.remember("work", AGENTS, "/api/tickets", []);
  assert.deepEqual(readdirSync(dir).sort(), ["personal.json", "work.json"], "no temporary file is left behind");
  assert.equal(statSync(join(dir, "personal.json")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("a file that cannot be read counts as empty, and the next good answer overwrites it", () => {
  const dir = lastKnownDir(tmpDir("last-known-"));
  mkdirSync(dir, { recursive: true });
  const entry = { value: 1, identity: AGENTS };
  for (const bad of ["not json", "[]", "null", JSON.stringify({ "/api/tickets": entry }), JSON.stringify({ "/api/tickets": { ...entry, readAt: "yesterday" } }), JSON.stringify({ "/api/tickets": { readAt: "2026-10-24T10:00:00.000Z", value: 1 } })]) {
    writeFileSync(join(dir, "personal.json"), bad);
    const store = createLastKnown(dir);
    assert.equal(store.recall("personal", AGENTS, "/api/tickets"), undefined, bad);
    store.remember("personal", AGENTS, "/api/tickets", TICKETS);
    assert.deepEqual(createLastKnown(dir).recall("personal", AGENTS, "/api/tickets")?.value, TICKETS, `${bad} is overwritten`);
  }
});

test("a connection name that is not a plain name is refused, so it can never leave the directory", () => {
  const store = createLastKnown(lastKnownDir(tmpDir("last-known-")));
  assert.throws(() => store.remember("../escape", AGENTS, "/api/tickets", TICKETS), /not a connection name/);
  assert.throws(() => store.recall("a/b", AGENTS, "/api/tickets"), /not a connection name/);
});

test("an answer that did not change is written again only after a minute, and one that changed at once", () => {
  const dir = lastKnownDir(tmpDir("last-known-"));
  let now = OPENED_AT;
  const store = createLastKnown(dir, { now: () => now, writeGapMs: 0 });
  const file = join(dir, "personal.json");
  store.remember("personal", AGENTS, "/api/queue", { entries: [] });
  const first = readFileSync(file, "utf8");
  now += 5_000;
  store.remember("personal", AGENTS, "/api/queue", { entries: [] });
  assert.equal(readFileSync(file, "utf8"), first, "the same answer five seconds on leaves the file alone");
  assert.equal(store.recall("personal", AGENTS, "/api/queue")?.readAt, "2026-10-24T10:00:05.000Z", "memory holds the latest time");
  now += 5_000;
  store.remember("personal", AGENTS, "/api/queue", { entries: [{ key: "A11-1" }] });
  assert.match(readFileSync(file, "utf8"), /A11-1/, "a changed answer is written at once");
  now += REWRITE_AFTER_MS;
  store.remember("personal", AGENTS, "/api/queue", { entries: [{ key: "A11-1" }] });
  assert.match(readFileSync(file, "utf8"), new RegExp(new Date(now).toISOString()), "an unchanged answer is written again after a minute");
});

test("changes inside the write gap are written when it ends, not on every change", async () => {
  const dir = lastKnownDir(tmpDir("last-known-"));
  const gap = 40;
  const store = createLastKnown(dir, { writeGapMs: gap });
  const file = join(dir, "personal.json");
  store.remember("personal", AGENTS, "/api/queue", { n: 1 });
  store.remember("personal", AGENTS, "/api/queue", { n: 2 });
  store.remember("personal", AGENTS, "/api/tickets", TICKETS);
  assert.match(readFileSync(file, "utf8"), /"n":1/, "the first answer was written at once, the rest are waiting");
  await new Promise((done) => setTimeout(done, gap * 3));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual([saved["/api/queue"].value, saved["/api/tickets"].value], [{ n: 2 }, TICKETS], "the gap's changes are all there once it ends");
  assert.equal(WRITE_GAP_MS > 0, true);
});

test("a connection keeps at most the newest paths", () => {
  const dir = lastKnownDir(tmpDir("last-known-"));
  const store = createLastKnown(dir, { writeGapMs: 0 });
  for (let page = 0; page < MOST_PATHS + 5; page += 1) store.remember("personal", AGENTS, `/api/page${page}`, [page]);
  assert.equal(store.recall("personal", AGENTS, "/api/page0"), undefined, "the oldest was dropped");
  assert.deepEqual(store.recall("personal", AGENTS, `/api/page${MOST_PATHS + 4}`)?.value, [MOST_PATHS + 4]);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, "personal.json"), "utf8"))).length, MOST_PATHS);
});

test("a directory that cannot be written leaves the answer in memory, and does not throw", () => {
  const root = tmpDir("last-known-");
  writeFileSync(join(root, "blocked"), "a file where the directory should be");
  const store = createLastKnown(join(root, "blocked", "last-known"));
  store.remember("personal", AGENTS, "/api/tickets", TICKETS);
  assert.deepEqual(store.recall("personal", AGENTS, "/api/tickets")?.value, TICKETS);
});
