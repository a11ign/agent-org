/**
 * Guard triage 4 of 6 (#906): extracted from `board-style.test.ts` (retired) rather than deleted along
 * with it. The rest of that file policed WORDING, CAPS and SECTION DETAIL — a class of defect a reader
 * catches faster than a build does, per the CI Reset's own risk acceptance. These two did not: they catch
 * the board's own DATA being wrong (a duplicated or silently-dropped record), which is exactly the
 * "wrong in the product" bar the kept set (group 1) uses, not the retiring "org shape" bar this row
 * otherwise applies. See docs/operational-lessons.md, "Guard triage 4 of 6", for the rest of the file's
 * reasoning and what else it asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/* ONE ENTRY, ONE FILE — AND NOTHING ENFORCED IT UNTIL THIS TEST.
 *
 * #159 names each file by the entry's own identity plus a hash of it. That is stable and unique while the
 * identity holds still, and it says nothing about what happens when somebody EDITS an identity: the entry
 * is written under a new name, the old file stays, and `reported()` reads BOTH. Found by simulating
 * exactly that on the real directory -- two gates for one command, and `order` values of 10 and 10, so
 * the record silently carried a duplicate AND the tie-break between them was arbitrary.
 *
 * A duplicated entry is not a cosmetic fault here. The board document quotes these figures, and the one
 * thing it must never do is report a number twice or report the wrong one of two.
 *
 * REFUSED AT PUSH RATHER THAN AT RENDER, deliberately. The 08:00 job runs unattended, and a refusal there
 * is a missing edition; a refusal here is a red test in front of the person who caused it.
 */
test("no two recorded entries share an identity or an order", () => {
  for (const [kind, identity] of [["gates", "command"], ["achievements", "issue"]] as const) {
    const dir = path.join(REPO, "docs/board/reported", kind);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, body: JSON.parse(readFileSync(path.join(dir, f), "utf8")) }));

    const byIdentity = new Map<string, string[]>();
    const byOrder = new Map<number, string[]>();
    for (const { file, body } of entries) {
      const id = String(body[identity]);
      byIdentity.set(id, [...(byIdentity.get(id) ?? []), file]);
      byOrder.set(body.order, [...(byOrder.get(body.order) ?? []), file]);
      assert.ok(typeof body.order === "number",
        `${kind}/${file} has no numeric order. An entry with no place in the sequence is appended `
        + "silently, and the document renders in that order — so it would move what the board reads "
        + "without anybody choosing to");
    }
    for (const [id, files] of byIdentity) {
      assert.equal(files.length, 1,
        `${kind}: ${files.length} files carry ${identity} ${JSON.stringify(id)} — ${files.join(", ")}. `
        + "Editing an identity writes a new file and leaves the old one, and BOTH are read, so the "
        + "document would quote the same measurement twice. Delete the stale file.");
    }
    for (const [order, files] of byOrder) {
      assert.equal(files.length, 1,
        `${kind}: ${files.length} files share order ${order} — ${files.join(", ")}. The tie-break `
        + "between them is the filename, which is not a decision anybody made about what the board reads.");
    }
  }
});

/* A KIND ON DISK THAT THE CONSTANT DOES NOT NAME IS SILENTLY DROPPED FROM THE DOCUMENT.
 *
 * `REPORTED_KINDS` governs which subdirectories of `docs/board/reported/` are read. Shrink it and
 * `reported()` returns no key for the missing kind, `?? []` turns that into an empty list, and the
 * edition renders ZERO achievements without failing anything. Measured: the full suite passes with the
 * constant shrunk, and the document loses all five.
 *
 * FOUND BY MUTATION, NOT BY READING -- and the first attempt found the wrong thing. `reported()` was
 * still hardcoding both kinds while claiming to derive them, so shrinking the constant changed nothing
 * and looked like coverage rather than a silent no-op edit. The mutation is what separated "the guard
 * does not bite" from "the code never read the constant".
 *
 * THE DIRECTION THAT MATTERS IS DISK -> CONSTANT. A kind the constant names but disk lacks is an empty
 * list, which is honest. A kind on disk the constant does not name is evidence that exists and is never
 * read, which is this project's oldest defect: unchecked is not clean.
 */
test("every entry directory on disk is named in REPORTED_KINDS", async () => {
  const { REPORTED_KINDS, reported } = await import("../../../../scripts/board-data.mjs");
  const root = path.join(REPO, "docs/board/reported");
  const onDisk = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);

  for (const kind of onDisk) {
    assert.ok((REPORTED_KINDS as string[]).includes(kind),
      `docs/board/reported/${kind}/ holds records that nothing reads: it is not in REPORTED_KINDS, so `
      + "`reported()` returns no key for it and the edition renders that section empty without failing. "
      + "Add it to the constant, or delete the directory — evidence that exists and is never read is "
      + "worse than evidence that is absent, because absence is visible");
  }
  // AND THE OTHER DIRECTION, so the constant cannot name a kind that does not exist: a phantom kind
  // contributes an empty list to every count and nothing ever says why it is empty.
  const built = reported();
  for (const kind of REPORTED_KINDS as string[]) {
    assert.ok(onDisk.includes(kind) || (built as Record<string, unknown>)[kind] !== undefined,
      `REPORTED_KINDS names ${kind}, which has no directory and no key in reported()`);
  }
});
