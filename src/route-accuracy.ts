// agent-org#688 (use 4 of a11ign/a11ign#4627): THE ROUTING PROVIDER'S ACCURACY, MEASURED. `provider-confidence.ts` says how SURE the provider was; nothing said whether it was RIGHT, and that one fact decides whether a
// confidence floor protects anything. A merged diff is a ground truth that already exists (the criteria in `engineer-route.ts` are themselves written from "the merge that settled the answer"), so this joins each
// row's latest `model-routing` decision to its merged diff and reports, for `score` and `mechanical`, how often the answer matched, by the confidence the provider gave it.
//
// THE ANSWER MEASURED IS THE ONE THE PROVIDER GAVE. An answer the floor held back was replaced by the fallback (`score` 5, `mechanical` no), but `settle` keeps the provider's own value as `asked`: that is
// what is scored, since "was it right" is a question about the provider and not about the fallback. An answer with no confidence (a 422, a refusal, a timeout) was never the provider's and is counted apart.
//
// HELD OUT. A row named as an example in the criteria was SHOWN to the provider with its answer, so its decision proves nothing: it is excluded and counted, never scored. The held-out set is every row any of the
// four questions' examples names, since all four sets are sent in one request.
//
// TWO TRUTHS, BOTH NAMED, BOTH CHOICES. They are the weakest part of this reading, so they are stated where a reader meets them:
//   `score`: the level of the NEAREST EXAMPLE in {@link SCORE_LEVEL_DATA}, by files and changed lines each on a log scale. The levels' examples overlap on both axes taken singly (level 5's smallest is 11 files, 435 lines,
//   inside level 3's and level 4's line spans), so a bracket on one axis does not name one level; the nearest example does, and a tie goes to the LOWER level.
//   `mechanical`: the diff is at most {@link MECHANICAL_MAX_FILES} files and {@link MECHANICAL_MAX_LINES} changed lines. The criteria's `yes` examples are 6, 22 and 2 lines; its `no` examples are 394 to 496. The
//   line is set just over the largest "a few stated edits" example (8 files, 47 lines): a diff that small can still have been designed (a short new module), so `mechanical` agreement is a size reading, not a proof.
//
// A SAMPLE UNDER {@link MIN_SAMPLE} IS NOT A RATE. It prints `n=<k>, not a rate`: one row moves a rate of four by 25 points, and a floor tuned on that would be tuned on noise.
//
// A DECISION WITH NO MERGED PULL REQUEST IS COUNTED AND NAMED, never dropped (an open row, or one merged in a repository not given), and a row asked more than once counts once with its ask count printed.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627): with no log there are no decisions and the reading says so, quietly.
//
// THE CRITERIA ARE HANDED IN, NOT IMPORTED. `engineer-route.ts` resolves the host's checkout when it is imported, so a top-level import would make this reading, and its test, refuse on a machine with no
// `AGENT_ORG_HOST` for a question that is only about lines it is handed. The CLI imports it when it runs and passes {@link criteriaOf}'s view of it.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";

/** The confidence buckets' inner edges: under 0.4, 0.4 to 0.55, 0.55 to 0.7, 0.7 and over. The last is the floor the host runs at (`minConfidence`), so "under 0.7 against 0.7 and over" is the floor's own question. */
export const BUCKET_EDGES = Object.freeze([0.4, 0.55, 0.7]);
export const FLOOR = BUCKET_EDGES[BUCKET_EDGES.length - 1];
/** The fewest decisions a bucket needs before its agreement is printed as a rate. */
export const MIN_SAMPLE = 10;
/** The largest diff a `mechanical: yes` is true of: files, and lines added plus removed (the criteria's own measure, less `.acceptance/` and `.changeset/`). */
export const MECHANICAL_MAX_FILES = 8;
export const MECHANICAL_MAX_LINES = 50;
/** The questions with no ground truth in a diff, printed as NOT MEASURED and never invented. */
export const NOT_MEASURED = Object.freeze({
  subsystems: "whether modules interact is a fact about the code before the change, which a diff does not carry",
  debugging: "whether the cause was stated is a fact about the row's text, which a diff does not carry",
});
/** A tracker named in a branch's tail: `…-agent-org-688` is that tracker's row 688, not a11ign's. */
const OTHER_TRACKERS = Object.freeze(["agent-org"]);
const LOG_SCALE_OFFSET = 1;
const PERCENT = 100;
const NAMED_ROWS = 40;

export type Scored = "score" | "mechanical";
const SCORED: readonly Scored[] = Object.freeze(["score", "mechanical"] as const);
/** The provider's own answer to one question and how sure it was; absent when it gave none (a 422, a refusal, a timeout, an unreadable answer). */
export type Given = { value: string | number; confidence: number };
export type RoutingDecision = { row: number; at: number; answers: Partial<Record<Scored, Given>> };
/** What a row's merged pull requests changed: the files (a file touched twice once) and the lines added plus removed, with how many merges that is. */
export type MergedDiff = { files: number; lines: number; merges: number };
/** The criteria as this reading needs them: each score level's examples' sizes, in level order, and every row an example names. */
export type Criteria = { scoreExamples: readonly (readonly { files: number; lines: number }[])[]; exampleRows: ReadonlySet<number> };

export type Bucket = { label: string; n: number; agreed: number; /** Score only: within one level of the truth. */ near: number | undefined; /** `undefined` under {@link MIN_SAMPLE}. */ rate: number | undefined; nearRate: number | undefined };
export type QuestionReading = { question: Scored; buckets: Bucket[]; underFloor: Bucket; atOrOver: Bucket; /** Rows whose latest decision carried no answer of the provider's for this question. */ noAnswer: number[] };
export type AccuracyReading = {
  /** Decisions that were the provider's (`via` jev), and the rows they are on. */
  decisions: number;
  rows: number;
  /** A row asked more than once, with its ask count. Every row counts once, by its LATEST decision. */
  repeated: { row: number; asks: number }[];
  heldOut: { row: number; asks: number }[];
  unjoined: { row: number; asks: number }[];
  /** Rows joined to a merged diff and not held out: the ones every reading below is over. */
  measured: number;
  questions: QuestionReading[];
  notMeasured: { question: keyof typeof NOT_MEASURED; why: string }[];
  /** Log lines of this use that looked like a decision and could not be read. */
  unreadable: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const ROW_ID = /^row-(\d+)$/;

/** The provider's answer to one question, or `undefined` when it gave none: a held-back answer is its `asked`, and an answer with no confidence was never the provider's. */
function givenOf(raw: unknown): Given | undefined {
  if (!isRecord(raw) || typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) return undefined;
  const value = raw.fellBack === true ? raw.asked : raw.value;
  return typeof value === "string" || typeof value === "number" ? { value, confidence: raw.confidence } : undefined;
}

/**
 * THE PROVIDER'S ROUTING DECISIONS out of the decision log, a line being its raw text or already parsed. Only a `model-routing` REQUEST that was `via: "jev"` is one: an outcome line carries no answers, and a
 * request every answer of which failed (`via: "none"`) is the provider not answering. A line that names a request and is not the shape `decision-provider` writes is counted, not dropped.
 */
export function routingDecisionsIn(lines: readonly unknown[]): { decisions: RoutingDecision[]; unreadable: number } {
  const decisions: RoutingDecision[] = [];
  let unreadable = 0;
  for (const raw of lines) {
    let line = raw;
    if (typeof raw === "string") {
      if (raw.trim() === "") continue;
      try {
        line = JSON.parse(raw);
      } catch {
        unreadable += 1;
        continue;
      }
    }
    if (!isRecord(line) || line.use !== "model-routing" || !isRecord(line.answers)) continue;
    if (line.via !== "jev") continue;
    const row = typeof line.id === "string" ? Number(ROW_ID.exec(line.id)?.[1]) : Number.NaN;
    if (!Number.isInteger(row) || typeof line.at !== "number") {
      unreadable += 1;
      continue;
    }
    const answers: RoutingDecision["answers"] = {};
    for (const question of SCORED) {
      const given = givenOf((line.answers as Record<string, unknown>)[question]);
      if (given !== undefined) answers[question] = given;
    }
    decisions.push({ row, at: line.at, answers });
  }
  return { decisions, unreadable };
}

const SIZE_TEXT = /^(\d+) files?, \+(\d+) -(\d+)$/;
const ROW_NAME = /^a11ign#(\d+)$/;
type CriteriaExample = { row: string; merged: string };
type CriteriaData = { score: readonly { examples: readonly CriteriaExample[] }[]; others: readonly { examples: readonly CriteriaExample[] }[] };

/**
 * THE CRITERIA'S VIEW from `engineer-route.ts`'s data: each score level's examples as sizes (`"11 files, +404 -31"` is 11 files and 435 lines; an example whose merge text is not a size, such as a row that
 * had no diff of its own, has none), and the a11ign rows every example names. `others` are the options of the three other questions, whose examples were sent in the same request.
 */
export function criteriaOf({ score, others }: CriteriaData): Criteria {
  const sizeOf = ({ merged }: CriteriaExample): { files: number; lines: number }[] => {
    const [, files, added, removed] = SIZE_TEXT.exec(merged) ?? [];
    return files === undefined ? [] : [{ files: Number(files), lines: Number(added) + Number(removed) }];
  };
  const named = [...score, ...others].flatMap((holder) => holder.examples.map(({ row }) => ROW_NAME.exec(row)?.[1])).filter((n): n is string => n !== undefined);
  return { scoreExamples: score.map((level) => level.examples.flatMap(sizeOf)), exampleRows: new Set(named.map(Number)) };
}

/** THE SCORE A DIFF EARNS: the level of the nearest example by files and lines each on a log scale, the lower level on a tie. */
export function truthScore(diff: Pick<MergedDiff, "files" | "lines">, { scoreExamples }: Pick<Criteria, "scoreExamples">): number | undefined {
  const at = (n: number): number => Math.log(n + LOG_SCALE_OFFSET);
  let best: { level: number; distance: number } | undefined;
  scoreExamples.forEach((examples, index) => {
    for (const example of examples) {
      const distance = Math.hypot(at(diff.files) - at(example.files), at(diff.lines) - at(example.lines));
      if (best === undefined || distance < best.distance) best = { level: index + 1, distance };
    }
  });
  return best?.level;
}

export const truthMechanical = (diff: Pick<MergedDiff, "files" | "lines">): boolean => diff.files <= MECHANICAL_MAX_FILES && diff.lines <= MECHANICAL_MAX_LINES;

const edgeLabel = (edge: number): string => String(edge);
/** The bucket labels, lowest confidence first. */
export const BUCKET_LABELS: readonly string[] = Object.freeze([
  `under ${edgeLabel(BUCKET_EDGES[0])}`,
  ...BUCKET_EDGES.slice(1).map((edge, i) => `${edgeLabel(BUCKET_EDGES[i])} to ${edgeLabel(edge)}`),
  `${edgeLabel(FLOOR)} and over`,
]);
const bucketOf = (confidence: number): number => BUCKET_EDGES.filter((edge) => confidence >= edge).length;

type Tally = { n: number; agreed: number; near: number };
const bucketFrom = (label: string, { n, agreed, near }: Tally, withNear: boolean): Bucket => ({
  label, n, agreed, near: withNear ? near : undefined,
  rate: n >= MIN_SAMPLE ? agreed / n : undefined,
  nearRate: withNear && n >= MIN_SAMPLE ? near / n : undefined,
});

/**
 * THE JOIN AND THE READING, PURE. `decisions` are {@link routingDecisionsIn}'s, `merges` the merged diff of each row that has one. Each row counts once by its latest decision (ties by input order); a row
 * the criteria name is held out, a row without a merge is unjoined, and every other row's answers are scored against the diff.
 */
export function routeAccuracy(decisions: readonly RoutingDecision[], merges: ReadonlyMap<number, MergedDiff>, criteria: Criteria, unreadable = 0): AccuracyReading {
  const latest = new Map<number, RoutingDecision>();
  const asks = new Map<number, number>();
  for (const decision of decisions) {
    asks.set(decision.row, (asks.get(decision.row) ?? 0) + 1);
    const had = latest.get(decision.row);
    if (had === undefined || decision.at >= had.at) latest.set(decision.row, decision);
  }
  const named = (rows: number[]): { row: number; asks: number }[] => rows.sort((a, b) => a - b).map((row) => ({ row, asks: asks.get(row) ?? 0 }));
  const rows = [...latest.keys()];
  const heldOut = rows.filter((row) => criteria.exampleRows.has(row));
  const unjoined = rows.filter((row) => !criteria.exampleRows.has(row) && !merges.has(row));
  const measured = rows.filter((row) => !criteria.exampleRows.has(row) && merges.has(row));

  const questions = SCORED.map((question): QuestionReading => {
    const tallies = BUCKET_LABELS.map((): Tally => ({ n: 0, agreed: 0, near: 0 }));
    const noAnswer: number[] = [];
    for (const row of measured) {
      const given = latest.get(row)?.answers[question];
      const diff = merges.get(row);
      if (given === undefined || diff === undefined) {
        noAnswer.push(row);
        continue;
      }
      const tally = tallies[bucketOf(given.confidence)];
      tally.n += 1;
      if (question === "score") {
        const truth = truthScore(diff, criteria);
        if (typeof given.value === "number" && truth !== undefined) {
          if (given.value === truth) tally.agreed += 1;
          if (Math.abs(given.value - truth) <= 1) tally.near += 1;
        }
      } else if ((given.value === "yes") === truthMechanical(diff)) tally.agreed += 1;
    }
    const withNear = question === "score";
    const sum = (list: Tally[]): Tally => list.reduce((a, t) => ({ n: a.n + t.n, agreed: a.agreed + t.agreed, near: a.near + t.near }), { n: 0, agreed: 0, near: 0 });
    const floorAt = BUCKET_EDGES.length - 1;
    return {
      question,
      buckets: tallies.map((tally, i) => bucketFrom(BUCKET_LABELS[i], tally, withNear)),
      underFloor: bucketFrom(`under ${edgeLabel(FLOOR)}`, sum(tallies.slice(0, floorAt + 1)), withNear),
      atOrOver: bucketFrom(`${edgeLabel(FLOOR)} and over`, sum(tallies.slice(floorAt + 1)), withNear),
      noAnswer: noAnswer.sort((a, b) => a - b),
    };
  });

  return {
    decisions: decisions.length,
    rows: rows.length,
    repeated: named(rows.filter((row) => (asks.get(row) ?? 0) > 1)),
    heldOut: named(heldOut),
    unjoined: named(unjoined),
    measured: measured.length,
    questions,
    notMeasured: (Object.entries(NOT_MEASURED) as [keyof typeof NOT_MEASURED, string][]).map(([question, why]) => ({ question, why })),
    unreadable,
  };
}

// --- the table ---

const pct = (share: number): string => `${Math.round(share * PERCENT)}%`;
const rowsText = (list: readonly { row: number; asks: number }[]): string => {
  const shown = list.slice(0, NAMED_ROWS).map(({ row, asks }) => `row-${row}${asks > 1 ? ` (asked ${asks} times)` : ""}`).join(", ");
  return list.length > NAMED_ROWS ? `${shown}, and ${list.length - NAMED_ROWS} more` : shown;
};
const cell = (bucket: Bucket, at: "rate" | "nearRate"): string => bucket.n === 0 ? "-" : bucket[at] === undefined ? `n=${bucket.n}, not a rate` : `${pct(bucket[at] as number)} of ${bucket.n}`;

/** THE TABLE the CLI prints. */
export function formatRouteAccuracy(reading: AccuracyReading): string {
  if (reading.decisions === 0) return "no provider decisions in the log";
  const out: string[] = [
    `Routing provider accuracy: ${reading.decisions} decisions via jev on ${reading.rows} rows, each row once by its latest decision.`,
    `Measured ${reading.measured} rows; held out ${reading.heldOut.length}; no merged pull request ${reading.unjoined.length}. A rate needs at least ${MIN_SAMPLE} decisions.`,
    `Truth: score is the level of the nearest example in the criteria (files and changed lines); mechanical is at most ${MECHANICAL_MAX_FILES} files and ${MECHANICAL_MAX_LINES} changed lines. The answer scored is the one the provider gave.`,
  ];
  for (const { question, buckets, underFloor, atOrOver, noAnswer } of reading.questions) {
    const withNear = question === "score";
    out.push("", `${question}`, `  ${"confidence".padEnd(16)}${"agrees with the diff".padEnd(26)}${withNear ? "within one level" : ""}`.trimEnd());
    for (const bucket of buckets) out.push(`  ${bucket.label.padEnd(16)}${cell(bucket, "rate").padEnd(26)}${withNear ? cell(bucket, "nearRate") : ""}`.trimEnd());
    out.push(`  the floor, ${FLOOR}:`);
    for (const bucket of [underFloor, atOrOver]) out.push(`    ${bucket.label.padEnd(14)}${cell(bucket, "rate").padEnd(26)}${withNear ? cell(bucket, "nearRate") : ""}`.trimEnd());
    if (noAnswer.length > 0) out.push(`  no answer of the provider's to score on ${noAnswer.length} measured rows: ${rowsText(noAnswer.map((row) => ({ row, asks: 0 })))}`);
  }
  for (const { question, why } of reading.notMeasured) out.push("", `${question}: NOT MEASURED (${why})`);
  if (reading.heldOut.length > 0) out.push("", `Held out, named as an example in the criteria (${reading.heldOut.length}): ${rowsText(reading.heldOut)}`);
  if (reading.unjoined.length > 0) out.push("", `No merged pull request found (${reading.unjoined.length}): ${rowsText(reading.unjoined)}`);
  if (reading.repeated.length > 0) out.push("", `Asked more than once, counted once (${reading.repeated.length}): ${rowsText(reading.repeated)}`);
  if (reading.unreadable > 0) out.push("", `${reading.unreadable} log line${reading.unreadable === 1 ? "" : "s"} could not be read and ${reading.unreadable === 1 ? "is" : "are"} not in this reading.`);
  return out.join("\n");
}

// --- the merges, from git ---

const MERGE_SUBJECT = /^Merge pull request #\d+ from \S+\/(\S+)$/;
const NOT_COUNTED = [".acceptance/", ".changeset/"];

/** The row a merge's branch was cut for: `agent/<slug>-<row>`. A tail naming another tracker (`…-agent-org-688`) is that tracker's row. */
export function rowOfMergeSubject(subject: string): number | undefined {
  const slug = MERGE_SUBJECT.exec(subject)?.[1];
  const digits = slug === undefined ? undefined : /-(\d+)$/.exec(slug);
  if (slug === undefined || digits === null || digits === undefined) return undefined;
  const before = slug.slice(0, digits.index);
  return OTHER_TRACKERS.some((tracker) => before.endsWith(tracker)) ? undefined : Number(digits[1]);
}

type Run = (repo: string, args: string[]) => string;
const gitIn: Run = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: sandboxGitEnv(), maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/** `git diff --numstat <merge>^1 <merge>` less `.acceptance/` and `.changeset/`: the paths and the lines added plus removed of each (a binary file is 0 lines). */
function numstat(repo: string, merge: string, run: Run): { path: string; lines: number }[] {
  return run(repo, ["diff", "--numstat", `${merge}^1`, merge]).split("\n").filter((line) => line !== "").map((line) => {
    const [added, removed, ...path] = line.split("\t");
    return { path: path.join("\t"), lines: (Number(added) || 0) + (Number(removed) || 0) };
  }).filter(({ path }) => !NOT_COUNTED.some((prefix) => path.startsWith(prefix)));
}

/**
 * THE MERGED DIFF OF EACH WANTED ROW across `repos`: every first-parent merge of `ref` whose branch ends in the row's number. A row merged more than once (a follow-up, a fix) is the union of its files and
 * the sum of its lines, with the merge count kept so it is printed. A path is namespaced by repository, so two repositories' `src/index.ts` are two files.
 */
export function mergesOf(rows: ReadonlySet<number>, repos: readonly string[], { ref = "origin/main", run = gitIn }: { ref?: string; run?: Run } = {}): Map<number, MergedDiff> {
  const files = new Map<number, Set<string>>();
  const lines = new Map<number, number>();
  const merges = new Map<number, number>();
  for (const repo of repos) {
    for (const entry of run(repo, ["log", "--first-parent", "--merges", "--format=%H%x09%s", ref]).split("\n")) {
      const [hash, subject = ""] = entry.split("\t");
      const row = rowOfMergeSubject(subject);
      if (row === undefined || !rows.has(row)) continue;
      const stat = numstat(repo, hash, run);
      const seen = files.get(row) ?? new Set<string>();
      for (const { path } of stat) seen.add(`${repo}\u0000${path}`);
      files.set(row, seen);
      lines.set(row, (lines.get(row) ?? 0) + stat.reduce((total, { lines: n }) => total + n, 0));
      merges.set(row, (merges.get(row) ?? 0) + 1);
    }
  }
  return new Map([...merges].map(([row, count]) => [row, { files: files.get(row)?.size ?? 0, lines: lines.get(row) ?? 0, merges: count }]));
}

// THE CLI. The host and the criteria are imported when it runs, for the reason the header gives.
const EXIT = { REPORTED: 0, CANNOT_READ: 2 };

function cannotRead(message: string): never {
  process.stderr.write(`CANNOT READ: ${message}\n`);
  process.exit(EXIT.CANNOT_READ);
}

/** An absent log is the provider never having been asked, so the reading is empty; any other failure to read it is not that. */
function readLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return [];
    return cannotRead(`the decision log could not be read (${(err as { code?: string })?.code ?? "unknown error"}). That is a failed read, NOT a provider asked nothing.`);
  }
}

async function main(): Promise<void> {
  refuseUnknownFlags(["--log=", "--repos=", "--ref="], { entry: import.meta.url, command: "node src/route-accuracy.ts" });
  const logPath = flagValue(process.argv, "log") ?? await (async () => {
    try {
      const { stateEntryPath } = await import("./host-config.ts");
      const { decisionLogPathFrom } = await import("./decision-provider.ts");
      return decisionLogPathFrom(stateEntryPath("wake-ledger"));
    } catch (err) {
      return cannotRead(`the decision log's place could not be worked out (${(err as Error)?.name ?? "unknown error"}); pass --log=<path>.`);
    }
  })();
  const repos = (flagValue(process.argv, "repos") ?? "").split(",").filter((repo) => repo !== "");
  const { decisions, unreadable } = routingDecisionsIn(readLog(logPath));
  if (decisions.length > 0 && repos.length === 0) cannotRead("--repos=<path>,<path> names the checkouts whose merged pull requests the rows are joined to; without it every row would read as unmerged.");
  const nothing: Criteria = { scoreExamples: [], exampleRows: new Set() };
  if (decisions.length === 0) {
    process.stdout.write(`${formatRouteAccuracy(routeAccuracy([], new Map(), nothing, unreadable))}\n`);
    process.exit(EXIT.REPORTED);
  }
  const route = await import("./engineer-route.ts");
  const criteria = criteriaOf({ score: route.SCORE_LEVEL_DATA, others: [route.MECHANICAL_DATA.yes, route.MECHANICAL_DATA.no, route.SUBSYSTEMS_DATA.yes, route.SUBSYSTEMS_DATA.no, route.DEBUGGING_DATA.yes, route.DEBUGGING_DATA.no] });
  let merges: Map<number, MergedDiff>;
  try {
    merges = mergesOf(new Set(decisions.map(({ row }) => row)), repos, { ref: flagValue(process.argv, "ref") });
  } catch (err) {
    return cannotRead(`git could not read a repository's merges (${(err as Error)?.message?.split("\n")[0] ?? "unknown error"}).`);
  }
  process.stdout.write(`${formatRouteAccuracy(routeAccuracy(decisions, merges, criteria, unreadable))}\n`);
  process.exit(EXIT.REPORTED);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
