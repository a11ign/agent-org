// no-token: gh -- files in a temporary directory, nothing spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { boardKey, boardKeyPath, readBoardKey } from "./board-key.ts";

test("the board makes its key once, readable by its owner only, and reads the same key at every start after", () => {
  const path = boardKeyPath(tmpDir("board-key-"));
  const first = boardKey(path);
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(boardKey(path), first, "a restart keeps the key, so a paired browser stays paired");
  assert.equal(readBoardKey(path), first);
});

test("a key file other users can read is refused, not used", () => {
  const path = boardKeyPath(tmpDir("board-key-wide-"));
  boardKey(path);
  chmodSync(path, 0o644);
  assert.throws(() => readBoardKey(path), /can be read by other users \(mode 644\): run chmod 600/);
  assert.throws(() => boardKey(path), /can be read by other users/);
});

test("a key file another user owns is refused, since that user knows the key", () => {
  const path = boardKeyPath(tmpDir("board-key-owner-"));
  boardKey(path);
  assert.throws(() => readBoardKey(path, statSync(path).uid + 1), /belongs to another user/);
});

test("reading the key before any board has made one says how to make it, and a file that holds no key is refused", () => {
  const dir = tmpDir("board-key-none-");
  assert.throws(() => readBoardKey(boardKeyPath(dir)), /does not exist: start the instance once with agent-org ticket:serve/);
  const junk = join(dir, "junk.key");
  writeFileSync(junk, "not a key\n", { mode: 0o600 });
  assert.throws(() => readBoardKey(junk), /does not hold a board key/);
});
