// no-token: gh -- the record is a file in a temporary folder; nothing is spawned
// A11-358: a record of the pull requests a run opened that cannot be read whole says so, and is never read as "the run opened none"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { readOpenedRecord } from "./opened-record.ts";
import { OPENED_FILE } from "./worker-files.ts";

const LAB = { repo: "a11ign/lab", url: "https://github.com/a11ign/lab/pull/159" };
const TOOLCHAIN = { repo: "a11ign/toolchain", url: "https://github.com/a11ign/toolchain/pull/60" };
const line = (pull: object) => `${JSON.stringify(pull)}\n`;

test("A11-358: no record yet is no problem, and a whole one reads whole", () => {
  const dir = tmpDir("ticket-record-");
  assert.deepEqual(readOpenedRecord(dir), { pulls: [], problem: null });
  writeFileSync(join(dir, OPENED_FILE), line(LAB) + line(TOOLCHAIN));
  assert.deepEqual(readOpenedRecord(dir), { pulls: [LAB, TOOLCHAIN], problem: null });
});

test("A11-358: a line that is not a pull request is reported and the others are kept", () => {
  const dir = tmpDir("ticket-record-");
  writeFileSync(join(dir, OPENED_FILE), `${line(LAB)}{not json\n${line({ repo: 1 })}${line(TOOLCHAIN)}`);
  assert.deepEqual(readOpenedRecord(dir), { pulls: [LAB, TOOLCHAIN], problem: "2 of 4 lines of opened-pulls.jsonl are not a pull request" });
});

test("A11-358: a record that cannot be read at all is reported with the reason, not read as empty", () => {
  const dir = tmpDir("ticket-record-");
  mkdirSync(join(dir, OPENED_FILE));
  const record = readOpenedRecord(dir);
  assert.deepEqual(record.pulls, []);
  assert.match(record.problem ?? "", /^opened-pulls\.jsonl cannot be read \(EISDIR/);
});
