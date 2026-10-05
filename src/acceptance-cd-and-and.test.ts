/**
 * #3596: `pr:open` REFUSED A ROW'S OWN `cd <dir> && ...` ACCEPTANCE with "an `&&`". #3026 declared the leading
 * `cd` legitimate and stripped it before tokenising the runner's arguments, but `testFileArgumentsResolve`
 * asked `unparseableConstruct` about the UNSTRIPPED line, so the `&&` it had just declared fine was the
 * thing it refused (found on #3593, measured on a11ign/agent-org#212).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { testFileArgumentsResolve } from "./acceptance-commands.mjs";

// This file by absolute path: CI runs the suite from the project root, where a cwd-relative `src/...` is no file.
const THIS_FILE = fileURLToPath(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "cd-and-and-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "a.test.ts"), "");

test("CONTROL: a bare `tsx --test` line with no cd is unchanged", () => {
  assert.deepEqual(testFileArgumentsResolve(`tsx --test ${THIS_FILE}`), { ok: true });
  assert.deepEqual(testFileArgumentsResolve("tsx --test nothing-here.test.ts"), { ok: false, missing: ["nothing-here.test.ts"] });
  assert.deepEqual(testFileArgumentsResolve("a && tsx --test a.test.ts"), { ok: false, unparseable: "an `&&`" });
});

test("a leading `cd <dir> &&` is not unparseable, and the file resolves against <dir>", () => {
  assert.deepEqual(testFileArgumentsResolve(`cd ${dir} && AGENT_ORG_HOST=x node --import tsx --test a.test.ts`), { ok: true });
});

test("a glob after the cd resolves against <dir> too", () => {
  assert.deepEqual(testFileArgumentsResolve(`cd ${dir} && tsx --test "*.test.ts"`), { ok: true });
  assert.deepEqual(testFileArgumentsResolve(`cd ${dir} && tsx --test "*.nothing.ts"`), { ok: false, missing: ["*.nothing.ts"] });
});

test("a file missing from <dir> is reported missing, even if it exists relative to this process", () => {
  assert.deepEqual(
    testFileArgumentsResolve(`cd ${dir} && tsx --test ${THIS_FILE.slice(1)}`),
    { ok: false, missing: [THIS_FILE.slice(1)] },
  );
});

test("a SECOND `&&` after the cd is still refused", () => {
  assert.deepEqual(
    testFileArgumentsResolve(`cd ${dir} && a && node --import tsx --test a.test.ts`),
    { ok: false, unparseable: "an `&&`" },
  );
});
