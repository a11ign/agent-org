// module: which words a shell script runs as commands, and whether it spawns `gh` (moved out of `host-units/shipped-unit-texts-and-declarations.ts`, A11-160)
//
// A LEAF, so the gh-call ratchet (`packaging/gh-call-inventory.ts`) can read shell scripts with the reader the host-drift check has always used, without loading the host's declaration.
import { basename } from "node:path";

/**
 * Shell comments, stripped at a WORD BOUNDARY. A `#` mid-token is a fragment, a colour or a format
 * string (`+%FT%TZ` sits one character away in the dispatch's own `date` call) and never opens a
 * comment; a `#` at the start of a word always does.
 */
const SHELL_COMMENT = /(^|\s)#[^\n]*/g;

/** The shell words that PRECEDE a command rather than being one, so a fragment's first word is not it. */
const SHELL_PREFIXES = new Set(["if", "then", "elif", "else", "while", "until", "for", "do", "!",
  "time", "exec", "command", "eval", "sudo", "nohup"]);

/** A `VAR=value` prefix, which is not the command either -- `firstRealToken`'s question, one file over. */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * EVERY WORD A SHELL WOULD RUN AS A COMMAND NAME, and nothing else -- #1998.
 *
 * `SPAWNS_GH` asks a JAVASCRIPT question (`execFileSync("gh", ...)`), and a shell script spawns `gh` by
 * writing the word. Same question, different grammar, so it needs its own reader rather than a looser
 * one: `\bgh\b` over the file would match a path, a branch name or a jq filter, and #1860 is this
 * repository's own record of that mistake costing a file which refused itself for being named after the
 * thing it fixed.
 *
 * SPLIT ON THE PARENTHESIS, NOT ONLY ON THE NEWLINE, because the dispatch's SECOND `gh` is
 * `RUN_ID="$(gh run list ...)"` -- the line's own first word is an assignment and the call sits one
 * substitution in. A reader that only asked about line-leading words would see one call and charge the
 * unit for half of what it actually spends. `(` covers `$(` and a bare subshell alike, and a separate
 * `\$\(` alternative was written here first and measured DEAD: removing it changed no answer, because
 * the character class had already split the same position.
 * @param {string} text @returns {string[]}
 */
export function shellCommandWords(text: string): string[] {
  return String(text ?? "").replace(SHELL_COMMENT, "$1")
    .split(/&&|\|\||[\n;()`|&]/)
    .map((fragment) => commandWord(fragment))
    .filter((word) => word !== "");
}

/** @param {string} fragment @returns {string} the word a shell would execute, or `""` for none */
function commandWord(fragment: string): string {
  return fragment.trim().split(/\s+/).filter(Boolean)
    .find((word) => !SHELL_PREFIXES.has(word) && !SHELL_ASSIGNMENT.test(word)) ?? "";
}

/**
 * Does this shell script spawn `gh`? By BASENAME, so `/usr/bin/gh` counts and `gh-real` does not.
 * @param {string} text @returns {boolean}
 */
export function shellSpawnsGh(text: string): boolean {
  return shellCommandWords(text)
    .some((word) => basename(word.replace(/^['"]|['"]$/g, "")) === "gh");
}
