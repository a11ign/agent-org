// no-token: none -- writes only into a temporary directory of its own
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { writeAtomic } from "./write-atomic.ts";

test("writeAtomic replaces a file whole, with the mode asked for, and leaves no temporary file", () => {
  const dir = tmpDir("write-atomic-");
  const path = join(dir, "host.json");
  writeFileSync(path, "old\n", { mode: 0o644 });
  writeAtomic(path, "new\n", 0o600);
  assert.equal(readFileSync(path, "utf8"), "new\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["host.json"]);
});

test("writeAtomic makes a missing directory 700 for a private file and 755 for another", () => {
  const dir = tmpDir("write-atomic-");
  writeAtomic(join(dir, "private", "linear.key"), "k\n", 0o600);
  writeAtomic(join(dir, "public", "agent-org.service"), "u\n", 0o644);
  assert.equal(statSync(join(dir, "private")).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "public")).mode & 0o777, 0o755);
  assert.equal(statSync(join(dir, "public", "agent-org.service")).mode & 0o777, 0o644);
});

test("writeAtomic writes through a link's name, never into the file the link points at", () => {
  const dir = tmpDir("write-atomic-");
  const target = join(dir, "elsewhere");
  writeFileSync(target, "theirs\n");
  symlinkSync(target, join(dir, "linear.key"));
  writeAtomic(join(dir, "linear.key"), "mine\n", 0o600);
  assert.equal(readFileSync(target, "utf8"), "theirs\n");
  assert.equal(readFileSync(join(dir, "linear.key"), "utf8"), "mine\n");
});

test("writeAtomic removes its temporary file when the rename fails, and throws", () => {
  const dir = tmpDir("write-atomic-");
  const path = join(dir, "taken");
  mkdirSync(join(path, "inside"), { recursive: true });
  assert.throws(() => writeAtomic(path, "x\n", 0o600));
  assert.deepEqual(readdirSync(dir), ["taken"]);
});
