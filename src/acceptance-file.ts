// WHERE THE ACCEPTANCE COMES FROM: THE FILE THE PULL REQUEST ADDS UNDER `.acceptance/`; THE BODY ONLY FOR DEPENDABOT (ADR 0044, rows #4418, #519).
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
// and nothing needs the branch name to be trusted. Zero added files used to fall back to the body (and said so, by name, because the fallback
// was being retired); two are refused the way two `Acceptance:` headers in one body are.
//
// THE BODY IS NOT A SOURCE ANY MORE (ADR 0044 row 3, agent-org#519). Zero added files is REFUSED, and so is a diff that could not be read (no
// file could be found in it), unless the pull request's author is one of `BODY_EXEMPT_AUTHORS`: Dependabot writes the pull request and its
// branch, so nothing there can add a file, and the ceo ruled a narrow exemption (a11ign#4811, (a)) over a new write credential.
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

/**
 * THE ONE EXEMPTION (agent-org#519, ADR 0044 row 3; ceo ruled (a) on a11ign#4811): the pull request authors whose BODY is still read as the
 * acceptance source when they add no `.acceptance/` file. Dependabot writes the pull request and its branch and nothing of ours commits to it,
 * so a rule that every pull request adds a file would refuse every dependency bump.
 *
 * The author is the login GitHub records, as `PR_AUTHOR` carries it, in the two spellings it is printed in: `dependabot[bot]` (the REST
 * `user.login`) and `app/dependabot` (what `gh` prints). A person's login holds only letters, digits and hyphens, so neither can be taken.
 * NOTHING the pull request's author writes decides it: not the body, a label or the branch name (`dependabot/npm/...` is a branch anyone can
 * push). Matched whole and case-sensitively, so a near miss is refused and never guessed at.
 *
 * It exempts the SOURCE only: a command read from a Dependabot body goes through the same classifier and allowlist as one read from a file,
 * because `acceptanceReport` is handed the text and does not know where it came from. Adding an entry is a ruling, not an edit.
 */
export const BODY_EXEMPT_AUTHORS: readonly string[] = ["dependabot[bot]", "app/dependabot"];

/**
 * Is `author` one whose body is read when it adds no file? `undefined` (`PR_AUTHOR` unset: the workflow did not say) is never exempt.
 * @param {string | undefined} author
 */
export function isBodyExemptAuthor(author: string | undefined): author is string {
  return author !== undefined && BODY_EXEMPT_AUTHORS.includes(author);
}

export type AcceptanceSource =
  | { kind: "file", path: string, text: string }
  /** Only for an exempt author (`BODY_EXEMPT_AUTHORS`): `author` is the one that was exempted, so the printed line can name it. */
  | { kind: "body", text: string, why: "no-file" | "diff-unreadable", author: string }
  /** No file, and the author is not exempt: there is no acceptance to read, and the body is not looked at. `author` is as given, or none. */
  | { kind: "refused", why: "no-file" | "diff-unreadable", author: string | undefined }
  | { kind: "duplicate", paths: string[] };

/**
 * THE READER. `added` is the paths the pull request ADDS (a modified or copied file is not added); `undefined` means the diff could not be
 * read, which is not the same as "adds nothing" and is reported as such. `read` reads one path of the head's tree and its failure
 * propagates: a file the diff says exists and cannot be opened is never read as "none".
 *
 * `author` is the login of the pull request's author (`PR_AUTHOR`), as GitHub reports it and never read from the body, a label or a branch name
 * (agent-org#666). With no added file it decides between the body (an author in `BODY_EXEMPT_AUTHORS`) and a refusal (anyone else, or none given).
 * @param {{ body: string, added: readonly string[] | undefined, read: (path: string) => string, author?: string }} input
 * @returns {AcceptanceSource}
 */
export function resolveAcceptanceSource({ body, added, read, author }: { body: string; added: readonly string[] | undefined; read: (path: string) => string; author?: string; }): AcceptanceSource {
  const noFile = (why: "no-file" | "diff-unreadable"): AcceptanceSource =>
    isBodyExemptAuthor(author) ? { kind: "body", text: body, why, author } : { kind: "refused", why, author };
  if (added === undefined) return noFile("diff-unreadable");
  const files = added.filter(isAcceptancePath).sort();
  if (files.length === 0) return noFile("no-file");
  if (files.length > 1) return { kind: "duplicate", paths: files };
  return { kind: "file", path: files[0], text: read(files[0]) };
}

/**
 * The line that names the source. `body` still begins `ACCEPTANCE-SOURCE: body`, so a count of the pull requests that print it keeps counting
 * the exempt ones, and `none` says WHY nothing was read so a refused author is told what to add.
 * @param {AcceptanceSource} source
 */
export function sourceLine(source: AcceptanceSource): string {
  if (source.kind === "file") return `${SOURCE_LABEL}: file ${source.path}`;
  if (source.kind === "duplicate") return `${SOURCE_LABEL}: ${source.paths.length} files (${source.paths.join(", ")})`;
  const unreadable = source.why === "diff-unreadable" ? "the diff could not be read, so no file added under .acceptance/ was found" : "this pull request adds no file under .acceptance/";
  if (source.kind === "body") return `${SOURCE_LABEL}: body (exempt author ${source.author}; ${unreadable}; agent-org#519)`;
  const who = source.author === undefined ? "no author was given" : `its author ${source.author} is not exempt`;
  return `${SOURCE_LABEL}: none (${unreadable} and ${who}, so the body is not read; add .acceptance/<branch with / as ~>.md)`;
}

/**
 * The text the `Acceptance:`-family sections are read from: the file's when there is one, the body's for an exempt author. A duplicate has none,
 * and a refusal has the EMPTY text, never `null` and never the body: the reports that fall back to the body on `null` (`mutation`) must not read
 * a body that was refused as a source, and `acceptanceReport` reads "" as the `ACCEPTANCE: MISSING` it is.
 * @param {AcceptanceSource} source
 */
export function sectionsTextOf(source: AcceptanceSource): string | null {
  if (source.kind === "duplicate") return null;
  return source.kind === "refused" ? "" : source.text;
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
