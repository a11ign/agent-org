// module: the account a ticket's next run gives of the work a closed pull request held, the brief that asks for it, and the check that refuses a plan without it (A11-249)
//
// STEP 1 OF A11-249 KEPT THE LIST (`pool-closed-work.ts` writes `<ticket folder>/closed-pulls/<owner>-<repo>-<n>.json`). THIS IS WHAT IS DONE WITH IT. A plan, and every pull request of the ticket, carries a `## Work from closed pull
// requests` section with a bullet for each commit and each file of every record that held unique work: the item, then `carried over` and where, or `dropped` and why. The check refuses a plan that leaves one out, as `findingsRefusal`
// refuses a plan that leaves a blocker's findings out, and the reviewer is handed the same list (`ReviewBrief.closedWork`) to check the pull request's account against the diff. A record of kind `none` held nothing and asks for none.
// Texts in, texts out, except `closedWorkOf`, which reads the ticket's folder.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOSED_PULLS_DIR, isClosedWorkRecord, type ClosedWorkRecord } from "./closed-work.ts";

/** The heading of the section a plan and a pull request body carry. */
export const ACCOUNT_HEADING = "## Work from closed pull requests";

/** A record of a closed pull request that held unique work, and the `.md` list the board kept beside it. */
export type KeptClosedWork = Readonly<{ file: string; record: Extract<ClosedWorkRecord, { kind: "unique" }> }>;

/** The shortest start of a SHA that names a commit in an account. */
const MIN_SHA = 7;

/** The most items a refusal names: the rest are counted. */
const NAMED_AT_MOST = 12;

/** Which audience a brief section is for: the planner, who writes the plan's account, or the worker, whose pull request body carries it. */
export type Audience = "plan" | "pull request";

/** The ticket's records of closed pull requests that held unique work, with the `.md` list kept for each, oldest pull request first. A record that cannot be read is skipped: the board's sweep writes it again. */
export function closedWorkOf(ticketFolder: string): KeptClosedWork[] {
  const dir = join(ticketFolder, CLOSED_PULLS_DIR);
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
  return names.flatMap((name): KeptClosedWork[] => {
    try {
      const record: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      return isClosedWorkRecord(record) && record.kind === "unique" ? [{ file: join(dir, name.replace(/\.json$/, ".md")), record }] : [];
    } catch (error) {
      void error; // a record that does not parse is rewritten by the sweep from the code host's own read
      return [];
    }
  }).sort((a, b) => a.record.number - b.record.number);
}

/** What a plan or pull request must account for: a commit by its SHA, a file by its path. */
type Item = Readonly<{ kind: "commit" | "file"; name: string; pull: number }>;

/** Every commit and file of `kept`, as the account must name them. PURE. */
const itemsOf = (kept: readonly KeptClosedWork[]): Item[] => kept.flatMap(({ record }) => [
  ...record.commits.map(({ sha }): Item => ({ kind: "commit", name: sha, pull: record.number })),
  ...record.files.map((file): Item => ({ kind: "file", name: file, pull: record.number })),
]);

/** The text of a document's `## Work from closed pull requests` section, or null when it has none: from the heading to the next heading of its own level or above. PURE. */
export function accountSection(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === ACCOUNT_HEADING.toLowerCase());
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** A bullet of the section split at its verdict: what it names, and what it says after `carried over` or `dropped`. */
type Bullet = Readonly<{ subject: string; detail: string }>;

const VERDICT = /carried over|dropped/i;

/** The bullets of a section that carry a verdict with something after it (where, or why), each with the text before the verdict as its subject. A bullet may wrap onto indented lines. PURE. */
function bulletsOf(section: string): Bullet[] {
  const bullets: string[] = [];
  for (const line of section.replace(/\*\*|__/g, "").split("\n")) {
    if (/^\s*[-*]\s/.test(line)) bullets.push(line.replace(/^\s*[-*]\s+/, ""));
    else if (bullets.length > 0 && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  return bullets.flatMap((bullet): Bullet[] => {
    const at = bullet.search(VERDICT);
    if (at === -1) return [];
    const detail = bullet.slice(at).replace(VERDICT, "").replace(/^[\s:,;()\-–—]+/, "").trim();
    return /[A-Za-z0-9]/.test(detail) ? [{ subject: bullet.slice(0, at), detail }] : [];
  });
}

/** The words a bullet's subject names: each backticked span whole, then the other words with the punctuation of the sentence left off. PURE. */
function namedIn(subject: string): string[] {
  const spans = [...subject.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const words = subject.replace(/`[^`]+`/g, " ").split(/[\s,;()]+/).map((word) => word.replace(/[.:]+$/, "")).filter((word) => word !== "");
  return [...spans, ...words].map((word) => word.trim());
}

/** Whether a word of a subject names `item`: a commit by the first {@link MIN_SHA} or more characters of its SHA, a file by its path, or by a directory (`path/`) it is under. PURE. */
function namesItem(word: string, { kind, name }: Item): boolean {
  if (kind === "commit") return word.length >= MIN_SHA && /^[0-9a-f]+$/i.test(word) && name.startsWith(word.toLowerCase());
  return word === name || (word.endsWith("/") && word.length > 1 && name.startsWith(word));
}

/** The items of `items` no bullet of the account names with a verdict. PURE. */
function unaccounted(account: string, items: readonly Item[]): Item[] {
  const named = bulletsOf(account).map(({ subject }) => namedIn(subject));
  return items.filter((item) => !named.some((words) => words.some((word) => namesItem(word, item))));
}

const label = ({ kind, name, pull }: Item): string => `${kind === "commit" ? `commit ${name.slice(0, MIN_SHA)}` : `file ${name}`} (#${pull})`;

/** The names of up to {@link NAMED_AT_MOST} items, and a count of the rest. */
const listed = (items: readonly Item[]): string => `${items.slice(0, NAMED_AT_MOST).map(label).join(", ")}${items.length > NAMED_AT_MOST ? ` and ${items.length - NAMED_AT_MOST} more` : ""}`;

/** The form the check accepts, as a fenced block, for the first commit and file of `kept`. PURE. */
function formOf(kept: readonly KeptClosedWork[]): string {
  const [first] = itemsOf(kept);
  const file = itemsOf(kept).find(({ kind }) => kind === "file");
  const lines = [`- \`${(first?.name ?? "").slice(0, MIN_SHA)}\`: carried over (<where: a path, a commit, a pull request or a step>) | dropped (<why>)`,
    ...(file === undefined ? [] : [`- \`${file.name}\`: carried over (<where>) | dropped (<why>)`, "- `a/directory/`: carried over (<where>) | dropped (<why>)   (covers every listed file under it)"])];
  return `\`\`\`markdown\n${ACCOUNT_HEADING}\n\n${lines.join("\n")}\n\`\`\``;
}

/**
 * Why a plan is refused for what it leaves out of the account of closed work, or null when nothing is missing. `texts` are the plan's files; the section may be in any one file. A ticket whose records all held nothing asks for no
 * account. The reason names what is missing, so the planner, or the person who reads the card, can add it. PURE.
 */
export function accountRefusal(texts: readonly string[], kept: readonly KeptClosedWork[]): string | null {
  const items = itemsOf(kept);
  if (items.length === 0) return null;
  const sections = texts.flatMap((text) => accountSection(text) ?? []);
  const pulls = [...new Set(kept.map(({ record }) => `#${record.number}`))].join(", ");
  if (sections.length === 0) {
    return `the plan has no "${ACCOUNT_HEADING}" section, though pull request ${pulls} of this ticket was closed with work not on its base: it must say, for each commit and file, carried over (where) or dropped (why). It misses ${listed(items)}`;
  }
  const missing = unaccounted(sections.join("\n"), items);
  return missing.length === 0 ? null : `the plan's "${ACCOUNT_HEADING}" section does not say carried over (where) or dropped (why) for ${listed(missing)}`;
}

/** One record as the brief lists it: its list file, the pull request, its branch and head, the fetch line, and how many commits and files it held. */
const recordLine = ({ file, record }: KeptClosedWork): string =>
  `- \`${file}\`: #${record.number}, ${record.url}, branch \`${record.branch}\` at \`${record.head}\` (${record.commits.length} commit(s), ${record.files.length} file(s) not on \`${record.base}\`). `
  + `To get the commits even if the branch is gone: \`git fetch origin pull/${record.number}/head\`, in a clone of the pull request's repository.`;

const commitLine = ({ sha, subject }: { sha: string; subject: string }): string => `  - \`${sha}\` ${subject}`;

/** What the planner is asked to write, the check's own rule and the exact form it accepts. PURE. */
const plannerRule = (kept: readonly KeptClosedWork[]): string =>
  `The plan must carry a \`${ACCOUNT_HEADING}\` section, before \`## Paths\`, with a bullet for each commit and each file in those lists: name a commit by its SHA (at least the first ${MIN_SHA} characters) and a file by its path, then say **carried over** and where (a path, a commit, a pull request or a step), or **dropped** and why. A bullet that names a directory (\`path/\`) covers every listed file under it. A plan without that section, or one that leaves an item out, is refused, and so is a bullet that says nothing after \`carried over\` or \`dropped\`. Write the section in exactly this form:\n\n${formOf(kept)}`;

/** What the worker is asked to write in its pull request body, which the reviewer checks against the diff. PURE. */
const workerRule = (): string =>
  `If your ticket was planned, its plan carries a \`${ACCOUNT_HEADING}\` section with a bullet for each commit and file. Your pull request body carries the same section, kept up to date with what the pull request did: a bullet for each commit and file, **carried over** and where (a path in this pull request, a commit, a pull request or a step) or **dropped** and why. The reviewer checks each \`carried over\` against your diff, and an item the section leaves out is a finding.`;

/**
 * The brief section for a ticket with closed work: every record with its list file, and the rule that the account names each commit and file as carried over (where) or dropped (why). The planner's gets the commits inline and the form
 * the check accepts; the worker's says its pull request body carries the same section, kept up to date. Nothing when the ticket has no such record. PURE.
 */
export function closedWorkText(kept: readonly KeptClosedWork[], audience: Audience): string {
  if (kept.length === 0) return "";
  const commits = audience === "plan" ? `\n\nTheir commits:\n\n${kept.map(({ record }) => `- #${record.number}\n${record.commits.map(commitLine).join("\n")}`).join("\n")}` : "";
  const rule = audience === "plan" ? plannerRule(kept) : workerRule();
  return `
## Work from closed pull requests

Pull requests of this ticket were closed without merging, and held work that is not on their base. The board kept a list for each. Read each list: parts of the work may be worth carrying over.

${kept.map(recordLine).join("\n")}${commits}

${rule}
`;
}

/** The most characters of the reviewer's list: a longer one is cut, as a reply is. */
const REVIEWER_LIST_LIMIT = 16000;

/**
 * The list the reviewer is handed for a ticket with closed work, one line per commit and file under a line for the pull request, or null when it has none. It is the board's record, so a claim in the pull request body is checked
 * against it and the diff. PURE.
 */
export function closedWorkLines(kept: readonly KeptClosedWork[]): string | null {
  if (kept.length === 0) return null;
  const text = kept.map(({ record }) => [`Closed pull request #${record.number} (${record.url}), branch ${record.branch}, work not on ${record.base}:`,
    ...record.commits.map(({ sha, subject }) => `- commit ${sha} ${subject}`), ...record.files.map((file) => `- file ${file}`),
    ...(record.filesComplete ? [] : ["- (the code host's compare stopped at its file cap: the files above are a part)"])].join("\n")).join("\n\n");
  return text.length > REVIEWER_LIST_LIMIT ? `${text.slice(0, REVIEWER_LIST_LIMIT)}\n[cut: ${text.length - REVIEWER_LIST_LIMIT} more characters]` : text;
}
