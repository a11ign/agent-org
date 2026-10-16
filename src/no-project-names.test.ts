// no-token: none -- reads the source tree from disk; nothing here runs a unit or reaches a remote.
/**
 * (#1591) agent-org STANDS ALONE: no non-test source names the project it serves. The name is read from `.agent-org/project.json` (through
 * `project-config.ts`) or taken as a parameter, so a second project on the same tool changes a declaration and nothing in the code.
 *
 * Test files may name the project -- they are fixtures of what the code reads -- and so may `src/packaging/fixtures`, which holds the host
 * declarations those tests load. Everything else under `src` is refused on a hit, and a line that moves the name into a comment or a renamed
 * constant is still a hit, because the guard reads the text, not the syntax.
 *
 * POSITIVE CONTROLS: a fixture string that contains the name is refused by the same scan (so the scan can see the name), the walk reaches
 * a floor of files (so a path that read as empty would not pass), and the fixtures the exemption names do hold the name (so the exemption is
 * not standing in for nothing).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { declareWalkScope } from "./lib/walk-scope.ts";

export const WALK_SCOPE = ["src"];
await declareWalkScope(import.meta.url);

const SRC = dirname(fileURLToPath(import.meta.url));
const NAME = /a11y-witness/;
const FIXTURES = "packaging/fixtures";
/** Enough files that a walk which found nothing would be obvious; the tree holds several hundred. */
const WALK_FLOOR = 100;

/** Every regular file under `src` (relative), excluding the test files and the fixtures. */
const sourceFiles = (): string[] => readdirSync(SRC, { recursive: true }).map(String)
  .filter((rel) => statSync(join(SRC, rel)).isFile())
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
  const dir = join(SRC, FIXTURES);
  const holding = readdirSync(dir, { recursive: true }).map(String)
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .filter((rel) => NAME.test(readFileSync(join(dir, rel), "utf8")));
  assert.ok(holding.length > 0, `no file under ${FIXTURES} names the project, so the exemption is standing in for nothing`);
});
