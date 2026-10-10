// WHERE THE ACCEPTANCE COMES FROM: THE FILE THE PULL REQUEST ADDS UNDER `.acceptance/`, ELSE THE BODY (ADR 0044, row #4418).
//
// WHY. The merge-blocking verdict was a function of the pull request's LIVE body, which anyone with write access can edit after the
// review: the commands CI runs were not the commands that were reviewed, and a description edit was a CI event. The commands now live in
// one file per pull request, in the diff the reviewer reads, so they move only with a new head SHA.
//
// ONE GRAMMAR, ONE PARSER. The file holds exactly what the body held -- the `Acceptance:` header, `Refutation`, `Mutation`, the hand-run
// and full-history declarations -- and the SAME `acceptanceReport` and `extract*Section` functions read it, because they already take a
// string. The only change is where the string comes from, and this module is that and nothing else. The `Closes` declaration stays in the
// body: GitHub acts on it at merge, so an edit to it SHOULD still run the checks (ADR 0044, decision 2).
//
// THE FILE THE PULL REQUEST ADDS, NOT THE FILE AT THE BRANCH'S NAME. A file already on `main` is never run, a renamed branch still works,
// and nothing needs the branch name to be trusted. Zero added files falls back to the body (and says so, by name, because the fallback is
// being retired); two are refused the way two `Acceptance:` headers in one body are.
//
// A LEAF: it imports nothing from this package (and its one writer lives HERE, not in `pr-open.ts`: `org-retro.test.ts` reads a file that names
// `hand-fix-ledger` and calls a write function as that ledger's writer, and `pr-open.ts` names it), so the Region check, `ownedPaths` and B4 can name the directory without dragging the parser in.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The directory every pull request's acceptance file lives in. A trailing `/` is a directory, as `region-paths.ts` reads an entry. */
export const ACCEPTANCE_DIR = ".acceptance/";

/** Printed on every report that read the Acceptance, so a reader of a CI log can tell which source ran. */
export const SOURCE_LABEL = "ACCEPTANCE-SOURCE";

/**
 * Is `path` an acceptance file? These are outside every row's Region, `ownedPaths` and B4 BY CONSTRUCTION: each pull request adds one named
 * for its own branch, so a Region that had to list it would be padding, and a refusal over it a false one.
 * @param {string} path
 */
export function isAcceptancePath(path: string): boolean {
  return path.startsWith(ACCEPTANCE_DIR);
}

/**
 * The file a branch's pull request adds: each `/` becomes `~`, so `agent/foo-4415` is `.acceptance/agent~foo-4415.md`. INJECTIVE because
 * `~` cannot appear in a git ref name (`git check-ref-format`), so two branches never share a file.
 * @param {string} branch
 */
export function acceptanceFileForBranch(branch: string): string {
  return `${ACCEPTANCE_DIR}${branch.replaceAll("/", "~")}.md`;
}

export type AcceptanceSource =
  | { kind: "file", path: string, text: string }
  | { kind: "body", text: string, why: "no-file" | "diff-unreadable" }
  | { kind: "duplicate", paths: string[] };

/**
 * THE READER. `added` is the paths the pull request ADDS (a modified or copied file is not added); `undefined` means the diff could not be
 * read, which is not the same as "adds nothing" and is reported as such. `read` reads one path of the head's tree and its failure
 * propagates: a file the diff says exists and cannot be opened is never read as "none".
 *
 * `author` is the login of the pull request's author (`PR_AUTHOR`), carried to the reader for agent-org#519's narrow exemption and USED FOR
 * NOTHING YET: it changes no verdict. It is the author as GitHub reports it, never read from the body, a label or a branch name.
 * @param {{ body: string, added: readonly string[] | undefined, read: (path: string) => string, author?: string }} input
 * @returns {AcceptanceSource}
 */
export function resolveAcceptanceSource({ body, added, read }: { body: string; added: readonly string[] | undefined; read: (path: string) => string; author?: string; }): AcceptanceSource {
  if (added === undefined) return { kind: "body", text: body, why: "diff-unreadable" };
  const files = added.filter(isAcceptancePath).sort();
  if (files.length === 0) return { kind: "body", text: body, why: "no-file" };
  if (files.length > 1) return { kind: "duplicate", paths: files };
  return { kind: "file", path: files[0], text: read(files[0]) };
}

/**
 * The line that names the source. The body's is "(deprecated)": the fallback ends when no open pull request prints it (ADR 0044, row 3).
 * @param {AcceptanceSource} source
 */
export function sourceLine(source: AcceptanceSource): string {
  if (source.kind === "file") return `${SOURCE_LABEL}: file ${source.path}`;
  if (source.kind === "duplicate") return `${SOURCE_LABEL}: ${source.paths.length} files (${source.paths.join(", ")})`;
  return source.why === "diff-unreadable"
    ? `${SOURCE_LABEL}: body (deprecated; the diff could not be read, so no added file was looked for)`
    : `${SOURCE_LABEL}: body (deprecated)`;
}

/**
 * The text the `Acceptance:`-family sections are read from: the file's when there is one, else the body. A duplicate has none.
 * @param {AcceptanceSource} source
 */
export function sectionsTextOf(source: AcceptanceSource): string | null {
  return source.kind === "duplicate" ? null : source.text;
}

/**
 * The default writer: creates `.acceptance/` on first use, relative to the working tree `pr-open` runs in.
 * @param {string} path
 * @param {string} text
 */
export function writeAcceptanceFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
