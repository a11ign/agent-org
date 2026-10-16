// agent-org#1268: THE REVIEWER'S SKILL IS PROVEN ON A LABELLED SET BEFORE IT IS SWITCHED ON, AND THE PROOF CAN BE RUN AGAIN.
//
// `src/skills/row-review/SKILL.md` is what a reviewer reviews with behind `review.rowReviewSkill`. Whether it makes the reviewer stop approving pull requests that skip a Done-when item,
// copy a helper or "test" by regex is a MEASUREMENT, not an opinion, so this file holds the measurement: a set of merged pull requests whose verdict was read blind (a11ign#928,
// comment 6133595219), each reviewed OFFLINE by the same reviewer model with the skill named, and the agreement printed.
//
// OFFLINE MEANS NOTHING IS POSTED. The reviewer is handed the pull request's title and body, the row it closes and the diff `baseRefOid...headRefOid` as FILES, and the tree at the head
// as its working directory, in a read-only sandbox, and is told to run no `gh`. Nothing here writes to GitHub: `EvalDeps` has no operation that does.
//
// THE REVIEWER IS NOT TOLD THE ANSWER. The prompt carries no label, no merge state and no comment; a body that gives its own away would be a leak the set cannot show.
//
// A RUN THAT GIVES NO VERDICT IS A DISAGREEMENT, NEVER A SKIP: an `unread` pull request (a read that failed) and a reply with no parseable verdict both count against the
// agreement, because a harness that dropped what it could not read would pass on the pull requests it did read.
//
// THE SKILL UNDER TEST IS THE CHECKOUT'S (`installSkill`), copied into each reviewed tree.
//
// NO `gh` CALL IS MADE IN THIS FILE. The reads and the reviewer are `EvalDeps`, supplied by `scripts/review-eval.ts`: a harness over closed pull requests is not the machinery's
// ticket port (`gh-call-ratchet.test.ts`), and the tests hand in fixtures.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeProjectDeclaration } from "./project-config.ts";

export type Label = "convinced" | "not convinced";

/** One pull request of a set: `repo` is `owner/name`, `label` is the blind read's verdict. */
export type EvalPr = { repo: string; number: number; label: Label; };

/** `blind-2026-10-12` is the blind read of 24 merged PRs (a11ign#928), the eleven the row (agent-org#1268) names. */
export const SETS: Readonly<Record<string, readonly EvalPr[]>> = Object.freeze({
  "blind-2026-10-12": Object.freeze([
    { repo: "a11ign/agent-org", number: 1243, label: "not convinced" },
    { repo: "a11ign/agent-org", number: 1138, label: "not convinced" },
    { repo: "a11ign/agent-org", number: 1060, label: "not convinced" },
    { repo: "a11ign/agent-org", number: 1211, label: "not convinced" },
    { repo: "a11ign/agent-org", number: 1057, label: "not convinced" },
    { repo: "a11ign/agent-org", number: 1068, label: "convinced" },
    { repo: "a11ign/agent-org", number: 1063, label: "convinced" },
    { repo: "a11ign/agent-org", number: 1100, label: "convinced" },
    { repo: "a11ign/agent-org", number: 1149, label: "convinced" },
    { repo: "a11ign/agent-org", number: 1078, label: "convinced" },
    { repo: homeProjectDeclaration().tracker[0].repo, number: 5289, label: "convinced" },
  ] satisfies EvalPr[]),
});

/** The reviewer's own model and effort (`cause-declaration.ts`, `draft-awaiting-verdict`): the eval measures the reviewer, not another model. */
export const REVIEWER_MODEL = "gpt-5.6-luna";
export const REVIEWER_EFFORT = "medium";

/** The skill AS THE REPOSITORY SHIPS IT, which the eval puts in the reviewed tree's `.agents/skills/` (Codex reads a project's skills there, probed 2026-10-13), so the proof is of the file in this checkout and never of whichever copy `host:install` last wrote. */
export const SKILL_SOURCE = fileURLToPath(new URL("./skills/row-review/", import.meta.url));
const SKILL_FILES = ["SKILL.md", "LICENSE"];

/** Put the shipped skill under `<tree>/.agents/skills/row-review/`. Throws when a file of it cannot be copied, so an eval never runs without the skill it claims to prove. */
export function installSkill(tree: string, source: string = SKILL_SOURCE): string {
  const target = join(tree, ".agents", "skills", "row-review");
  mkdirSync(target, { recursive: true });
  for (const name of SKILL_FILES) copyFileSync(join(source, name), join(target, name));
  return target;
}

export const idOf = (pr: EvalPr): string => `${pr.repo.replace(/^[^/]+\//, "")}#${pr.number}`;

/** `9/11` is "at least nine of eleven". A refusal throws, so a typo cannot be read as no requirement. */
export function parseRequire(text: string): { need: number; of: number; } {
  const found = /^(\d+)\/(\d+)$/.exec(text.trim());
  if (found === null) throw new Error(`--require wants N/M, such as 9/11, and got "${text}"`);
  const need = Number(found[1]);
  const of = Number(found[2]);
  if (of === 0 || need > of) throw new Error(`--require ${text} asks for more agreements than there are pull requests`);
  return { need, of };
}

/**
 * The verdict a review reply gives. THE LAST LINE decides, `VERDICT: convinced` or `VERDICT: not convinced` (what the prompt asks for), and `not convinced` is tested FIRST by
 * being matched whole: "not convinced" contains "convinced", so a substring test would read every refusal as an approval. The role file's own first line
 * (`**Review of #n at head, by reviewer: not convinced — ...**`) is the fallback when no last line says; two that disagree are `null`, not a pick. `null` is "no verdict".
 */
export function verdictOf(reply: string): Label | null {
  const lines = reply.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const shape = (text: string, pattern: RegExp): Label | null => {
    const found = pattern.exec(text.replace(/[*_`]/g, ""));
    return found === null ? null : found[1].toLowerCase() === "not convinced" ? "not convinced" : "convinced";
  };
  const last = lines.length === 0 ? null : shape(lines[lines.length - 1], /^VERDICT:\s*(not convinced|convinced)\b[^\n]*$/i);
  const first = lines.length === 0 ? null : shape(lines[0], /\bby reviewer:\s*(not convinced|convinced)\b/i);
  if (last !== null && first !== null && last !== first) return null;
  return last ?? first;
}

export type Row = { title: string; body: string; };
export type PullRequest = { title: string; body: string; baseRefOid: string; headRefOid: string; };

/**
 * The row a pull request closes, as `{repo, number}`: the first `Closes <owner>/<repo>#N` or bare `Closes #N` (the pull request's own repository) in its body, or `null`.
 * `Closes: none` and a body with no closing line are `null`, which the harness reports as `unread`, since a review with no row has no spec to hold the diff to.
 */
export function closedRowOf(body: string, repo: string): { repo: string; number: number; } | null {
  const found = /\bcloses?:?\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/i.exec(body);
  return found === null ? null : { repo: found[1] ?? repo, number: Number(found[2]) };
}

/** The files a review reads, written under `dir`: the pull request, the row and the diff. Returns their paths. */
export function writeInputs(dir: string, pr: PullRequest, row: Row, diff: string): { pullRequest: string; row: string; diff: string; } {
  const paths = { pullRequest: join(dir, "pull-request.md"), row: join(dir, "row.md"), diff: join(dir, "diff.patch") };
  writeFileSync(paths.pullRequest, `# ${pr.title}\n\n${pr.body}\n`);
  writeFileSync(paths.row, `# ${row.title}\n\n${row.body}\n`);
  writeFileSync(paths.diff, diff);
  return paths;
}

/**
 * The prompt a reviewer is given. It NAMES the skill (Codex runs one only when the prompt says so, and a `review-agent` skill of its own exists), points at the files, and says
 * nothing may be posted. It states no label.
 */
export function reviewPrompt(inputs: { pullRequest: string; row: string; diff: string; }): string {
  return [
    "Review a pull request with the `row-review` skill. This is an OFFLINE evaluation: post nothing, run no `gh` command and change nothing.",
    `- The pull request (title and body): ${inputs.pullRequest}`,
    `- The row it closes (its Done-when, Change, Region and Acceptance are the spec): ${inputs.row}`,
    `- The diff, merge base to head: ${inputs.diff}`,
    "- The tree at the pull request's head is the current directory, read-only, a single-commit checkout with no history: search it with `git grep` or `grep -rn`.",
    "The Acceptance command was not run and is not held against the pull request; read the tests it would run.",
    "Finish with one last line, exactly `VERDICT: convinced` or `VERDICT: not convinced`, and nothing after it.",
  ].join("\n");
}

export type Result = { pr: EvalPr; got: Label | null; agreed: boolean; note: string; reply: string | null; };

export type EvalDeps = {
  readPullRequest: (repo: string, number: number) => PullRequest;
  readRow: (repo: string, number: number) => Row;
  readDiff: (repo: string, base: string, head: string) => string;
  /** Put the tree of `sha` in the (empty, existing) `dir`. */
  checkout: (repo: string, sha: string, dir: string) => void;
  /** Ask the reviewer, working in `cwd`, and return its last message. */
  review: (opts: { cwd: string; prompt: string; model: string; effort: string; }) => Promise<string>;
};

/** One pull request, through its own scratch directory under `workDir`. Never throws: a failed read is a `Result` with `got: null` and the reason. */
export async function evaluateOne(pr: EvalPr, deps: EvalDeps, { workDir, model, effort, skillSource }: { workDir: string; model: string; effort: string; skillSource?: string; }): Promise<Result> {
  const unread = (note: string): Result => ({ pr, got: null, agreed: false, note, reply: null });
  try {
    const dir = mkdtempSync(join(workDir, `${idOf(pr).replace(/[^A-Za-z0-9]/g, "-")}-`));
    const tree = join(dir, "head");
    mkdirSync(tree);
    const pull = deps.readPullRequest(pr.repo, pr.number);
    const closed = closedRowOf(pull.body, pr.repo);
    if (closed === null) return unread("unread: the pull request's body names no row it closes");
    const row = deps.readRow(closed.repo, closed.number);
    const diff = deps.readDiff(pr.repo, pull.baseRefOid, pull.headRefOid);
    if (diff.trim() === "") return unread("unread: the diff is empty");
    deps.checkout(pr.repo, pull.headRefOid, tree);
    installSkill(tree, skillSource);
    const reply = await deps.review({ cwd: tree, prompt: reviewPrompt(writeInputs(dir, pull, row, diff)), model, effort });
    writeFileSync(join(dir, "review.md"), reply);
    const got = verdictOf(reply);
    if (got === null) return { pr, got, agreed: false, note: `no verdict in the reply (kept at ${join(dir, "review.md")})`, reply };
    return { pr, got, agreed: got === pr.label, note: `kept at ${join(dir, "review.md")}`, reply };
  } catch (error) {
    return unread(`unread: ${String((error as Error).message).split("\n")[0]}`);
  }
}

/** Run `items` through `work`, at most `jobs` at once, keeping the order. */
async function pooled<T, R>(items: readonly T[], jobs: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (let at = next++; at < items.length; at = next++) out[at] = await work(items[at]);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(jobs, 1), items.length) }, lane));
  return out;
}

export type Score = { agreed: number; total: number; negatives: { agreed: number; total: number; }; pass: boolean | null; };

/**
 * The agreement, and whether it clears `require`. THE REQUIREMENT HAS TWO PARTS, and the second is not optional: at least `need` agreements AND every pull request labelled
 * `not convinced` agreed, because the row's reason for being is the reviewer that approves what it should refuse (Done-when 1: "including all 5"). `pass` is `null` when no
 * requirement was asked for.
 */
export function score(results: readonly Result[], require: { need: number; of: number; } | null): Score {
  const negatives = results.filter((result) => result.pr.label === "not convinced");
  const agreed = results.filter((result) => result.agreed).length;
  const negativesAgreed = negatives.filter((result) => result.agreed).length;
  const pass = require === null ? null : results.length === require.of && agreed >= require.need && negativesAgreed === negatives.length;
  return { agreed, total: results.length, negatives: { agreed: negativesAgreed, total: negatives.length }, pass };
}

/** The report, one line per pull request and then the agreement. */
export function report(results: readonly Result[], s: Score, require: { need: number; of: number; } | null, model: string, effort: string): string {
  const lines = results.map((r) => `${r.agreed ? "AGREE   " : "DISAGREE"} ${idOf(r.pr).padEnd(22)} blind: ${r.pr.label.padEnd(13)} reviewer: ${(r.got ?? "(none)").padEnd(13)} ${r.note}`);
  const need = require === null ? "" : `, required ${require.need}/${require.of} with every not-convinced agreeing`;
  return [`row-review eval (${model}, effort ${effort})`, ...lines,
    `agreement ${s.agreed}/${s.total} (not convinced ${s.negatives.agreed}/${s.negatives.total})${need}`,
    s.pass === null ? "no requirement asked" : s.pass ? "PASS" : "FAIL"].join("\n") + "\n";
}

export const USAGE = "usage: review-eval --set <name> [--require N/M] [--only agent-org#1243,...] [--jobs N] [--model M] [--effort E]  (each also as --flag=value)\n  sets: " + Object.keys(SETS).join(", ");

/** The command. Returns the exit code: 0 pass or no requirement, 1 below the requirement, 2 a refusal. `argv` is what follows the script name. */
export async function main(argv: readonly string[], deps: EvalDeps, { out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text), workDir, skillSource }: { out?: (text: string) => void; err?: (text: string) => void; workDir?: string; skillSource?: string; } = {}): Promise<number> {
  const options = new Map<string, string>();
  for (let at = 0; at < argv.length; at++) {
    // `--set name` and `--set=name` both, because the row's Acceptance command is written the first way.
    const arg = argv[at];
    const found = /^--(set|require|only|jobs|model|effort)(?:=(.*))?$/.exec(arg);
    const value = found === null ? undefined : found[2] ?? argv[++at];
    if (found === null || value === undefined) {
      err(`REFUSED unknown or incomplete argument: ${arg}\n${USAGE}\n`);
      return 2;
    }
    options.set(found[1], value);
  }
  const name = options.get("set");
  const set = name === undefined ? undefined : SETS[name];
  if (set === undefined) {
    err(`REFUSED: --set names no set${name === undefined ? "" : ` called ${name}`}\n${USAGE}\n`);
    return 2;
  }
  let require: { need: number; of: number; } | null = null;
  try {
    require = options.has("require") ? parseRequire(options.get("require") as string) : null;
  } catch (error) {
    err(`REFUSED: ${(error as Error).message}\n`);
    return 2;
  }
  const only = options.get("only")?.split(",").filter(Boolean);
  const chosen = only === undefined ? set : set.filter((pr) => only.includes(idOf(pr)));
  if (chosen.length === 0) {
    err(`REFUSED: --only names no pull request of ${name}\n`);
    return 2;
  }
  if (require !== null && require.of !== chosen.length) {
    err(`REFUSED: --require ${require.need}/${require.of} is asked of ${chosen.length} pull request(s); a subset cannot clear a requirement written for the set\n`);
    return 2;
  }
  const model = options.get("model") ?? REVIEWER_MODEL;
  const effort = options.get("effort") ?? REVIEWER_EFFORT;
  const work = workDir ?? mkdtempSync(join(tmpdir(), "review-eval-"));
  const results = await pooled(chosen, Number(options.get("jobs") ?? "4"), (pr) => evaluateOne(pr, deps, { workDir: work, model, effort, skillSource }));
  const s = score(results, require);
  out(report(results, s, require, model, effort));
  return s.pass === false ? 1 : 0;
}
