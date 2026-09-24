/**
 * The reviewer's worktree recipe must not build the tree `suiteStartVerdict` refuses (#2378).
 *
 * `reviewer.md` ordered `ln -sfn <dir>/node_modules /private/tmp/rv-<PR>/node_modules`: the WHOLE
 * `node_modules` linked to the primary checkout, so every `@a11ign/*` resolves to the primary's source.
 * #2218's `assert-glob-not-empty.mjs --run` refuses that tree (`OTHER_CHECKOUT`), which means every
 * Acceptance the reviewer runs fails before its first test — and on #2375 (2026-09-24) it returned NOT
 * CONVINCED on the setup refusal rather than on a defect. The role doc and the guard were each right on
 * their own; nothing compared them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROLE_DOC = fileURLToPath(new URL("../../docs/roles/reviewer.md", import.meta.url));

/** Split a shell line into words, dropping quotes; enough for the `ln` lines a recipe carries. */
function words(line: string): string[] {
  return line.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
}

/**
 * The lines that symlink a WHOLE `node_modules` — the source operand of an `ln -s...` ends in
 * `node_modules` itself, not in an entry beneath it. Comment lines are skipped: the recipe explains
 * the refused line in prose and must be free to name it.
 *
 * Arguments are split and flags dropped, rather than one regex over the line, so `ln -sfn -- src dst`
 * and `ln -s -f src dst` are read the same as `ln -sfn src dst`.
 */
function wholeTreeNodeModulesLinks(text: string): string[] {
  return text.split("\n").filter((line) => {
    if (line.trim().startsWith("#")) return false;
    const [command, ...args] = words(line);
    if (command !== "ln") return false;
    const operands = args.filter((a) => !a.startsWith("-"));
    return operands.length > 0 && /(^|\/)node_modules\/?$/.test(operands[0]);
  });
}

/** The line as it stood in the shipped recipe before #2378 — the positive control. */
const REFUSED_LINE = "  ln -sfn <dir>/node_modules /private/tmp/rv-<PR>/node_modules";

test("the refused fixture line is caught, in the spellings a recipe could take", () => {
  assert.deepEqual(wholeTreeNodeModulesLinks(REFUSED_LINE), [REFUSED_LINE]);
  for (const spelling of [
    "ln -s <dir>/node_modules rv/node_modules",
    "ln -sf -- <dir>/node_modules/ rv/node_modules",
    'ln -sfn "$PRIMARY/node_modules" "$RV/node_modules"',
  ]) {
    assert.equal(wholeTreeNodeModulesLinks(spelling).length, 1, spelling);
  }
});

test("a per-entry link, a comment naming the refused line and prose are NOT read as the refused shape", () => {
  for (const line of [
    'ln -sfn "$e" "/private/tmp/rv-<PR>/node_modules/$(basename "$e")"',
    "ln -sfn <dir>/node_modules/.bin /private/tmp/rv-<PR>/node_modules/.bin",
    "# never: ln -sfn <dir>/node_modules /private/tmp/rv-<PR>/node_modules",
    "the whole node_modules is symlinked",
  ]) {
    assert.deepEqual(wholeTreeNodeModulesLinks(line), [], line);
  }
});

test("the shipped reviewer recipe symlinks no whole node_modules, and still builds its own @a11ign links", () => {
  const text = readFileSync(ROLE_DOC, "utf8");
  assert.deepEqual(wholeTreeNodeModulesLinks(text), []);
  // Positive control for the emptiness above: the recipe still carries `ln` lines at all, and the hybrid's
  // half that points `@a11ign/*` at THIS tree — deleting the recipe would otherwise pass.
  assert.match(text, /^\s*ln -sfn .*\.venv/m);
  assert.match(text, /node_modules\/@a11ign\/\$\(basename "\$p"\)/);
  assert.match(text, /npm --prefix \/private\/tmp\/rv-<PR> run build/);
});
