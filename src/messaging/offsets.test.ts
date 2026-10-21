// no-token: none -- the offset is a small file in a scratch folder
//
// THE LISTENER'S OFFSET (A11-162: moved out of the Telegram provider, since where the offset is kept is the core's whichever provider listens).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createOffsetStore } from "./offsets.ts";

const scratch = mkdtempSync(join(tmpdir(), "offsets-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("an offset written is read back, in a file only the listener can read, and the file is replaced whole", () => {
  const path = join(scratch, "state", "offset.json");
  const store = createOffsetStore(path);
  assert.equal(store.read(), undefined, "no file is no offset");
  store.write(13);
  assert.equal(store.read(), 13);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { offset: 13 });
  assert.equal(statSync(path).mode & 0o777, 0o600, "the file is the listener's alone");
  store.write(21);
  assert.equal(createOffsetStore(path).read(), 21, "a restart asks from the last offset");
});

test("a corrupt file, and one that holds no offset, are 'no offset', said in the log: the ledger's dedupe makes asking from the start safe", () => {
  const logs: string[] = [];
  const corrupt = join(scratch, "corrupt.json");
  writeFileSync(corrupt, "{not json");
  assert.equal(createOffsetStore(corrupt, { log: (line) => logs.push(line) }).read(), undefined);
  const wrong = join(scratch, "wrong.json");
  writeFileSync(wrong, JSON.stringify({ offset: -3 }));
  assert.equal(createOffsetStore(wrong, { log: (line) => logs.push(line) }).read(), undefined);
  assert.match(logs[0], /offset file .*corrupt\.json is unreadable/);
  assert.match(logs[1], /does not hold an offset; asking from the start/);
});
