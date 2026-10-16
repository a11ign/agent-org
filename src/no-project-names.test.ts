// no-token: none -- reads the tracked source tree (`git ls-files`) and the files in it; nothing here runs a unit or reaches a remote.
/**
 * (#1591) agent-org STANDS ALONE: no non-test source names the project it serves. The name is read from `.agent-org/project.json` (through
 * `project-config.ts`) or taken as a parameter, so a second project on the same tool changes a declaration and nothing in the code.
 *
 * Test files may name the project -- they are fixtures of what the code reads -- and so may `src/packaging/fixtures`, which holds the host
 * declarations those tests load. Everything else under `src` is refused on a hit, and a line that moves the name into a comment or a renamed
 * constant is still a hit, because the guard reads the text, not the syntax.
 *
 * THE FILES ARE WHAT HEAD COMMITS, under `src`. A file a runner left on its disk or its index (a stray from an earlier job, never committed) is
 * not source, and a walk of the disk or of the index would refuse it for a name it does not own (agent-org#1611's CI, 2026-10-16). The text of
 * each committed file is read from the disk, so an edit that has not been committed yet is still scanned.
 *
 * POSITIVE CONTROLS: a fixture string that contains the name is refused by the same scan (so the scan can see the name), the walk reaches
 * a floor of files (so a path that read as empty would not pass), and the fixtures the exemption names do hold the name (so the exemption is
 * not standing in for nothing).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { declareWalkScope } from "./lib/walk-scope.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";

export const WALK_SCOPE = ["src"];
await declareWalkScope(import.meta.url);

const SRC = dirname(fileURLToPath(import.meta.url));
const NAME = /a11y-witness/;
const FIXTURES = "packaging/fixtures";
/** Enough files that a walk which found nothing would be obvious; the tree holds several hundred. */
const WALK_FLOOR = 100;

/** Every file HEAD commits under `src` (relative to it). `git ls-tree` run in `src` lists only that subtree, with paths relative to it. */
const trackedFiles = (): string[] => execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", "HEAD"], { cwd: SRC, encoding: "utf8", env: sandboxGitEnv() })
  .split("\0").filter(Boolean);

/** Every tracked file under `src`, excluding the test files and the fixtures. */
const sourceFiles = (): string[] => trackedFiles()
  .filter((rel) => !rel.endsWith(".test.ts") && !rel.endsWith(".test.mjs") && !rel.startsWith(`${FIXTURES}/`));

/** The lines of `text` that name the project, as `line: text`. */
const namingLines = (text: string): string[] => text.split("\n")
  .flatMap((line, index) => (NAME.test(line) ? [`${index + 1}: ${line.trim()}`] : []));

test("#1591 no non-test, non-fixture source names the project it serves", () => {
  const hits = sourceFiles().flatMap((rel) => namingLines(readFileSync(join(SRC, rel), "utf8")).map((hit) => `${rel}:${hit}`));
  assert.deepEqual(hits, []);
});

test("#1591 CONTROL: the walk reaches the source tree, not an empty path", () => {
  assert.ok(sourceFiles().length >= WALK_FLOOR, `only ${sourceFiles().length} source files were walked`);
});

test("#1591 POSITIVE CONTROL: a fixture string that names the project is refused by the same scan", () => {
  const fixture = "const HOST_REPOS = \"/home/agent/repos/a11y-witness\";\n// a comment that names it: a11y-witness";
  assert.equal(namingLines(fixture).length, 2);
});

test("#1591 EXEMPTION CONTROL: the fixtures the exemption names do hold the name", () => {
  const holding = trackedFiles().filter((rel) => rel.startsWith(`${FIXTURES}/`))
    .filter((rel) => NAME.test(readFileSync(join(SRC, rel), "utf8")));
  assert.ok(holding.length > 0, `no file under ${FIXTURES} names the project, so the exemption is standing in for nothing`);
});
