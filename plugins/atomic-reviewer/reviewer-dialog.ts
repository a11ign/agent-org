// @ts-check
// module: the dialog a blocked reviewer is stopped on -- answered when it is Codex's trust dialog for a host repository, left for a person otherwise (A11-221)
//
// A REVIEWER THAT HERDR SHOWS `blocked` IS WAITING ON A DIALOG NOBODY ANSWERS. `codex-trust.ts` trusts the host file's repositories before a review starts, so Codex's "Trust this folder?" should not show for one; this is
// the net for when it still does (a config Codex resolved another root from, an entry written after the checkout was made) and for every other first-run or update dialog Codex can show. The port reads the pane only
// when herdr lists the seat's agent blocked, and answers ONE dialog: the trust dialog whose repository root the host file names, by `enter` on its selected `1. Trust and continue`. It sends no other key for any dialog:
// every other one is `stuck`, with its first line, for the pool to tell a person.
import type { ReviewerDialog } from "../../src/plugins/contracts/reviewer.ts";
import type { ReviewerBoard } from "../../src/plugins/manifest.ts";
import type { Ensured } from "./codex-trust.ts";

/** The trust answers a seat's head gets before the dialog is reported as stuck: a dialog that comes back after two answers is not one an answer cures, and a loop must reach a person. */
export const MAX_TRUST_ANSWERS = 2;

/** The most characters of a dialog's first line that are reported. */
const FIRST_LINE_CHARS = 200;

/** The heading of Codex's trust dialog. */
const TRUST_HEADING = "Trust this folder?";
const TRUST_QUESTION = /^Trust this folder\?/;

/** The line of the dialog that names the root the trust applies to; the root is the path after it. */
const TRUST_ROOT = /repository root:\s*(\/\S+)/;

/** The selected option of the trust dialog: a selector (`›`, `❯` or `>`) on `1. Trust and continue`, which `enter` answers. */
const TRUST_SELECTED = /^[\s│┃]*[›❯>]\s+1[.)]\s+Trust and continue\b/m;

/** The trailing punctuation a sentence puts after a path, which is no part of it. */
const AFTER_PATH = /[.,;:]+$/;

/** What a pane shows: the first line of its dialog, and, for Codex's trust dialog, the root it names (null when no root is read) and whether `1. Trust and continue` is the selected option. */
export type PaneDialog = Readonly<{ first: string; trust: Readonly<{ root: string | null; selected: boolean }> | null }>;

/** The dialog a pane's text shows, or null when it shows none (`readDialogLines` is core's reader, handed over in `board().herdr`). PURE. */
export function readPaneDialog(pane: string, readDialogLines: ReviewerBoard["herdr"]["readDialogLines"]): PaneDialog | null {
  const read = readDialogLines(pane);
  if (read === null) return null;
  const first = read.paragraph[0].slice(0, FIRST_LINE_CHARS);
  if (!TRUST_QUESTION.test(read.dialog.question)) return { first, trust: null };
  const root = TRUST_ROOT.exec(read.paragraph.join(" "))?.[1].replace(AFTER_PATH, "") ?? null;
  // Only the text from the dialog's own heading down: an option line left higher on the screen is not this dialog's.
  return { first, trust: { root, selected: TRUST_SELECTED.test(pane.slice(Math.max(0, pane.lastIndexOf(TRUST_HEADING)))) } };
}

/** Whether a dialog is a trust dialog this seat's head may be answered on: it names a root, `1. Trust and continue` is the selected option, and it has answers left. PURE. */
const mayAnswer = (trust: PaneDialog["trust"], answers: number): trust is { root: string; selected: boolean } => trust !== null && trust.root !== null && trust.selected && answers < MAX_TRUST_ANSWERS;

/**
 * What the port does about a dialog (`seen`): answers the trust dialog of a host repository and reports `answered`, and reports every other as `stuck` without pressing anything. `answers` is how many trust answers this
 * seat's head has had. `ensure` trusts a root when the host file names it; `press` sends `enter` and answers a promise of whether herdr took it (A11-379).
 *
 * A trust dialog is left alone when: its root cannot be read; `1. Trust and continue` is not the selected option; the root is not the host file's; the config cannot be written; the root already has an entry that is not
 * `trusted` (a person's choice, which Codex's own Trust would override); or it has been answered {@link MAX_TRUST_ANSWERS} times.
 */
export async function answerDialog({ seen, answers, ensure, press }: Readonly<{ seen: PaneDialog; answers: number; ensure: (root: string) => Ensured; press: () => Promise<boolean> }>): Promise<ReviewerDialog> {
  const stuck = { stuck: seen.first };
  const { trust } = seen;
  if (!mayAnswer(trust, answers)) return stuck;
  const ensured = ensure(trust.root);
  const trusted = ensured.kind === "added" || (ensured.kind === "present" && ensured.level === "trusted");
  return trusted && await press() ? { answered: seen.first } : stuck;
}
