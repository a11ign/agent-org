// no-token: gh -- files in a temporary directory
/** A11-431, step 2 of 2: a run is stored by its set, sha and key, and found again by a sha's start, with its key when it set one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { loadRun, parseRef, runFileName, setNameOf, storeRun, type StoredRun } from "./store.ts";

const SHA_A = "0d450e9".padEnd(40, "1");
const SHA_B = "0d450ea".padEnd(40, "2");
const run = (sha: string, key: StoredRun["key"] = null, dirty = false): StoredRun => ({ v: 1, set: "first", sha, dirty, key, model: "opus", effort: "high", at: 1, stopped: null, results: [] });

test("a set's results folder is named by the set, without its path or .json, and a run's file by its sha and key", () => {
  assert.equal(setNameOf("first"), "first");
  assert.equal(setNameOf("./evals/sets/first.json"), "first");
  assert.equal(runFileName({ sha: SHA_A, dirty: false }, null), `${SHA_A}.json`);
  assert.equal(runFileName({ sha: SHA_A, dirty: false }, { name: "tickets.drafts", on: false }), `${SHA_A}@tickets.drafts=off.json`);
  assert.equal(runFileName({ sha: SHA_A, dirty: true }, { name: "tickets.drafts", on: true }), `${SHA_A}-dirty@tickets.drafts=on.json`);
});

test("a stored run is read back by its sha's start, and a key's run only by naming its key", () => {
  const dir = tmpDir("run-eval-store-");
  const path = storeRun(dir, run(SHA_A));
  storeRun(dir, run(SHA_A, { name: "tickets.drafts", on: true }));
  assert.equal(path, join(dir, "first", `${SHA_A}.json`));
  assert.deepEqual(readdirSync(join(dir, "first")).sort(), [`${SHA_A}.json`, `${SHA_A}@tickets.drafts=on.json`], "no partial file is left behind");
  assert.deepEqual(loadRun(dir, "first", "0d450e9"), run(SHA_A));
  assert.deepEqual(loadRun(dir, "first", "0d450e9@tickets.drafts=on").key, { name: "tickets.drafts", on: true });
  assert.throws(() => loadRun(dir, "first", "0d450e9@tickets.drafts=off"), /no stored run of first is 0d450e9@tickets\.drafts=off \(stored: /);
});

test("a ref that matches two runs, none, or is not a ref is refused naming what it found", () => {
  const dir = tmpDir("run-eval-store-");
  storeRun(dir, run(SHA_A));
  storeRun(dir, run(SHA_B));
  assert.throws(() => loadRun(dir, "first", "0d450e"), /0d450e names 2 stored runs of first: .*; give more of the sha/);
  assert.equal(loadRun(dir, "first", "0d450ea").sha, SHA_B);
  assert.throws(() => loadRun(dir, "other", "0d450e9"), /no stored run of other is 0d450e9 \(stored: none\)/);
  assert.equal(parseRef("main"), null);
  assert.equal(parseRef("0d4"), null, "a ref of fewer than four characters matches too much");
  assert.deepEqual(parseRef("0d450e9@tickets.drafts=on"), { sha: "0d450e9", dirty: false, key: "tickets.drafts=on" });
  assert.deepEqual(parseRef("0D450E9-dirty"), { sha: "0d450e9", dirty: true, key: null }, "a sha typed in capitals is read in lower case");
  assert.equal(existsSync(join(dir, "other")), false, "reading makes no folder");
});

test("a run with uncommitted changes is stored apart from the clean run at its sha, and read only as -dirty", () => {
  const dir = tmpDir("run-eval-store-");
  const clean = storeRun(dir, run(SHA_A));
  const dirty = storeRun(dir, run(SHA_A, null, true));
  assert.notEqual(dirty, clean);
  assert.equal(loadRun(dir, "first", "0d450e9").dirty, false);
  assert.equal(loadRun(dir, "first", "0d450e9-dirty").dirty, true);
});
