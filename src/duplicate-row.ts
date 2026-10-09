// #4634: DOES THIS NEW ROW DUPLICATE AN OPEN ONE? `duplicateTitleRefusal` (#4294) compares titles by an exact rule, and #4535 and #4536 were twins and were filed anyway. Code chooses
// the open rows whose titles share at least half their words (the CANDIDATES, by the board-truth audit's own measure, imported and never copied), at most five; the decision provider is then
// asked three atomic questions per candidate: the same change, the same defect, or does one supersede the other.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). With no provider declared, no key, the use switched off, a refusal, a timeout or a confidence under the floor, `decide` answers each
// question's fallback ("no"), nothing here is refused, and `row-file` goes on to `duplicateTitleRefusal` exactly as it did. The provider only classifies: this module turns an answer into a
// refusal or a warning line, and the provider never files, merges or approves anything.
//
// THE STATE IS TRIMMED. Per pair: both titles and both Region lists, never a body. The candidate's Region is read from its row (one `gh issue view` per candidate, five at most), the new
// row's from the body being filed.
import { decide, decisionLogPathFrom, decisionSwitchesPath, readSwitches, recordOutcome, type DecisionDeps, type Question } from "./decision-provider.ts";
import { printDiagnostic, processState } from "./triage-provider.ts";
import { readFileSync } from "node:fs";
import { DUPLICATE_SIMILARITY, namesDifferentRepos, similarity, wordsOf } from "./board-truth-audit.ts";
import { extractRegionSection, regionPathsFromBody } from "./region-paths.ts";

export const DISTINCT_FROM_FLAG = "--distinct-from=";
/** At most this many candidates are asked about: each costs three questions and a row read. */
export const MAX_CANDIDATES = 5;
/** Title words in common, over all words, at or above which an open row is a candidate. Never above the audit's own bar, so every twin the audit would name is asked about. */
export const CANDIDATE_OVERLAP = Math.min(0.5, DUPLICATE_SIMILARITY);
const OPEN_ROW_READ_LIMIT = 1000;
const MAX_REGION_PATHS = 12;
const USE = "duplicate-row";

const YES_NO = Object.freeze({ yes: "It is.", no: "It is not, or this cannot be told from the titles and Regions given." });
const QUESTIONS: Readonly<Record<"sameChange" | "sameDefect" | "supersedes", Question>> = Object.freeze({
  sameChange: { type: "choice", instructions: "State holds `incoming`, a row about to be filed, and `existing`, an open row, each with a title and the files its Region names. Would doing the existing row make the incoming one unnecessary, because both ask for the same change?", criteria: YES_NO, fallback: "no" },
  sameDefect: { type: "choice", instructions: "State holds `incoming`, a row about to be filed, and `existing`, an open row, each with a title and the files its Region names. Do they describe the same defect, however differently worded?", criteria: YES_NO, fallback: "no" },
  supersedes: { type: "choice", instructions: "State holds `incoming`, a row about to be filed, and `existing`, an open row, each with a title and the files its Region names. Does one of them contain the other's work, so that finishing the larger one finishes both?", criteria: YES_NO, fallback: "no" },
});

type RowRef = { number: number; title: string };
export type Run = (cmd: string, args: string[]) => string;
export type Verdict = { sameChange: boolean; sameDefect: boolean; supersedes: boolean };
export type DuplicateCheck = { refusal: string | null; warnings: string[] };
export type DuplicateInput = {
  argv: string[];
  title: string;
  /** The body being filed: its Region is half of every pair's state. */
  body: string;
  repo: string;
  run: Run;
  host: DecisionDeps["host"];
  /** Where the project's `decisions.json` and the decision log are; absent means no switches file and no log. */
  projectDir?: string;
  ledgerPath?: string;
  deps?: Omit<DecisionDeps, "host" | "id" | "logPath" | "switchesPath">;
};

const numberOf = (text: string): number | null => (/^#?(\d+)$/.exec(text.trim()) ? Number(text.trim().replace(/^#/, "")) : null);

/** Every `--distinct-from=<n>` value given, as row numbers; a value that is not one is in `bad`. */
export function distinctFromOf(argv: string[]): { numbers: number[]; bad: string[] } {
  const values = argv.filter((arg) => arg.startsWith(DISTINCT_FROM_FLAG)).map((arg) => arg.slice(DISTINCT_FROM_FLAG.length));
  return { numbers: values.flatMap((v) => numberOf(v) ?? []), bad: values.filter((v) => numberOf(v) === null) };
}

/** The `Distinct-from:` lines that record on the new row which open rows its filer said it is not a copy of. */
export function appendDistinctFrom(body: string, argv: string[]): string {
  const { numbers } = distinctFromOf(argv);
  if (numbers.length === 0) return body;
  return `${body.replace(/\s+$/, "")}\n\n${[...new Set(numbers)].map((n) => `Distinct-from: #${n}`).join("\n")}\n`;
}

/** The open rows worth asking about, most alike first: code chooses them, and the provider never sees a row code did not. */
export function candidatesFor(title: string, open: readonly RowRef[], { skip = [] }: { skip?: readonly number[] } = {}): (RowRef & { overlap: number })[] {
  const wanted = wordsOf(title);
  return open
    .filter((row) => !skip.includes(row.number) && !namesDifferentRepos({ number: 0, title }, { number: row.number, title: row.title }))
    .map((row) => ({ ...row, overlap: similarity(wanted, wordsOf(row.title)) }))
    .filter((row) => wanted.size > 0 && row.overlap >= CANDIDATE_OVERLAP)
    .sort((a, b) => b.overlap - a.overlap || a.number - b.number)
    .slice(0, MAX_CANDIDATES);
}

const regionOf = (body: string): string[] => regionPathsFromBody(extractRegionSection(body) ?? "").slice(0, MAX_REGION_PATHS);

function openRows(repo: string, run: Run): RowRef[] | null {
  try {
    const rows = JSON.parse(run("gh", ["issue", "list", "--repo", repo, "--state", "open", "--limit", String(OPEN_ROW_READ_LIMIT), "--json", "number,title"]));
    return Array.isArray(rows) ? rows.filter((r) => Number.isInteger(r?.number) && typeof r?.title === "string") : null;
  } catch {
    return null; // an unreadable board asks nobody: the exact-title rule still runs, and says so itself when IT cannot read
  }
}

function bodyOf(number: number, repo: string, run: Run): string {
  try {
    return String(JSON.parse(run("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body"]))?.body ?? "");
  } catch {
    return ""; // a Region that cannot be read is an empty list in the state, not a reason to stop asking about the titles
  }
}

const yes = (answer: { value: string | number } | undefined): boolean => answer?.value === "yes";
const pairId = (title: string, number: number): string => `${title.trim().toLowerCase().replace(/\s+/g, " ")} -> #${number}`;

async function askPair(input: DuplicateInput, candidate: RowRef & { overlap: number }): Promise<Verdict> {
  const { title, body, repo, run, host, projectDir, ledgerPath, deps } = input;
  const state = {
    incoming: { title, region: regionOf(body) },
    existing: { title: candidate.title, region: regionOf(bodyOf(candidate.number, repo, run)) },
    titleOverlap: Math.round(candidate.overlap * 100) / 100,
  };
  const decision = await decide(USE, state, QUESTIONS, {
    ...deps, host, id: pairId(title, candidate.number),
    ...(projectDir === undefined ? {} : { switchesPath: decisionSwitchesPath(projectDir) }),
    ...(ledgerPath === undefined ? {} : { logPath: decisionLogPathFrom(ledgerPath) }),
  });
  return { sameChange: yes(decision.answers.sameChange), sameDefect: yes(decision.answers.sameDefect), supersedes: yes(decision.answers.supersedes) };
}

const refusalText = (title: string, found: { number: number; title: string }, verdict: Verdict, repo: string): string => {
  const what = verdict.sameChange && verdict.sameDefect ? "the same change and the same defect" : verdict.sameChange ? "the same change" : "the same defect";
  return `row-file: REFUSING to file -- the decision provider reads this row as ${what} as the open row #${found.number} ("${found.title}") in ${repo}. `
    + `If #${found.number} is the row you meant, work it there. If this is a different row, say so on the filing: pass \`${DISTINCT_FROM_FLAG}${found.number}\`, `
    + `which is recorded on the new row as \`Distinct-from: #${found.number}\` ("${title.trim()}"). Nothing was filed (#4634).`;
};

const supersedeWarning = (found: RowRef): string => `row-file: warning -- the decision provider reads this row and the open row #${found.number} ("${found.title}") as one containing the other's work (#4634).`;

/** The outcome label a later filing carries into the decision log, so a false positive is countable. */
const FOLLOWED = "distinct-from-followed";
const REFUSED = "refused";

/** Whether this use would be asked at all: a provider declared AND the use switched on. Checked first so a host that has not opted in reads no row and runs no `gh`. */
function askedAtAll({ host, projectDir, deps }: DuplicateInput): boolean {
  if (host.triage?.provider !== "jev") return false;
  const switches = deps?.switches ?? (projectDir === undefined ? {} : readSwitches(decisionSwitchesPath(projectDir), { diagnostic: deps?.diagnostic ?? printDiagnostic, state: deps?.state ?? processState, read: deps?.read ?? readFileSync }));
  return switches[USE] === true;
}

/** A filing that carries `--distinct-from` answers the refusal; the log hears that it followed, for every pair the provider was configured to be asked about. */
function recordFollowed(input: DuplicateInput, numbers: readonly number[]): void {
  if (input.host.triage?.provider !== "jev" || input.ledgerPath === undefined) return;
  for (const n of numbers) recordOutcome(USE, pairId(input.title, n), FOLLOWED, { ...input.deps, logPath: decisionLogPathFrom(input.ledgerPath) });
}

/**
 * THE SEMANTIC DUPLICATE CHECK. `refusal` is null when the filing may go on, which is also the answer whenever the provider did not say `yes` above its floor: the caller then runs the
 * exact-title rule as it always did. A `--distinct-from=<n>` takes row n out of the candidates (the filer has said it is not a copy) and is recorded in the decision log as followed.
 */
export async function duplicateRowCheck(input: DuplicateInput): Promise<DuplicateCheck> {
  const { numbers, bad } = distinctFromOf(input.argv);
  if (bad.length > 0) return { refusal: `row-file: REFUSING to file -- \`${DISTINCT_FROM_FLAG}${bad[0]}\` is not a row number. Nothing was filed (#4634).`, warnings: [] };
  if (numbers.length > 0) recordFollowed(input, numbers);
  if (!askedAtAll(input)) return { refusal: null, warnings: [] }; // provider absent or the use off: asks nobody, reads nothing, takes the exact-title rule
  const open = openRows(input.repo, input.run);
  if (open === null) return { refusal: null, warnings: [] };
  const verdicts = await Promise.all(candidatesFor(input.title, open, { skip: numbers }).map(async (candidate) => ({ candidate, verdict: await askPair(input, candidate) })));
  const same = verdicts.find(({ verdict }) => verdict.sameChange || verdict.sameDefect);
  const warnings = verdicts.filter(({ verdict }) => verdict.supersedes && !verdict.sameChange && !verdict.sameDefect).map(({ candidate }) => supersedeWarning(candidate));
  if (same === undefined) return { refusal: null, warnings };
  recordOutcome(USE, pairId(input.title, same.candidate.number), REFUSED, { ...input.deps, ...(input.ledgerPath === undefined ? {} : { logPath: decisionLogPathFrom(input.ledgerPath) }) });
  return { refusal: refusalText(input.title, same.candidate, same.verdict, input.repo), warnings };
}
