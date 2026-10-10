// #4635: REVIEW DEPTH. A pull request's reviewer is told how hard to look: `light` for a docs or test-only change, `normal` for the ordinary case, `full` for anything risky.
// THIS MODULE ROUTES NOTHING AND ACTS ON NOTHING: `reviewDepth` returns the depth as DATA, and the reviewer's order (`wake.ts`, not here) puts `depthLine(depth)` in its text.
//
// CODE DECIDES FIRST. A workflow, an auth or token path, `SECURITY.md`, `.claude/rules/` or a closed row's gate-bearing path is `full` with no question asked, so the provider
// cannot lower a risky diff and is never shown one. The provider only classifies the rest, by three atomic questions over a trimmed state (paths, line counts, title: never a body).
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). No provider, no key, the use switched off, a refusal, a timeout or a confidence under the floor all answer `normal`, which is the
// reviewer's order as it was before this module. A reviewer may raise the depth and never lower it (`raiseDepth`).
//
// THE CALLER IS `wake.ts` (#4888), where a reviewer's order is delivered and its instance started: {@link readDepthState} reads the diff there (REST, the core pool), and {@link depthEffort}
// is the effort the reviewer is started with. The gate is synchronous and a provider call is not, so the gate cannot be the caller.
import { decide, recordOutcome, type DecisionDeps, type Question } from "./decision-provider.ts";
import { regionEntries } from "./engineer-route.ts";
import { splitRegionEntry } from "./region-paths.ts";
import type { Gh } from "./ci-failure-class.ts";

export const DEPTHS = Object.freeze(["light", "normal", "full"] as const);
export type Depth = (typeof DEPTHS)[number];
/** What the diff is, trimmed: `closesPaths` is the Region of each row the PR closes, so a `Closes:` that names a gate-bearing path reads as one. */
export type DepthState = { paths: readonly string[]; added: number; removed: number; title: string; closesPaths?: readonly string[] };
export type ReviewDepth = { depth: Depth; by: "code" | "jev" | "none"; reason: string };

const MAX_PATHS = 40;
const MAX_TEXT = 120;
const USE = "review-depth";

/** Paths whose change is risky whatever it does. */
const FULL_BY_CODE: readonly RegExp[] = [
  /^\.github\/workflows\//,
  /^\.claude\/rules\//,
  /(^|\/)SECURITY\.md$/,
  /(^|[/._-])(auth|oauth|authz|tokens?|secrets?|credentials?|permissions?)([/._-]|$)/i,
];
const DOC_OR_TEST: readonly RegExp[] = [/\.test\.(ts|mjs)$/, /(^|\/)(tests?|__tests__|fixtures?)\//, /\.md$/, /^docs\//];

export const gateBearing = (path: string): boolean => FULL_BY_CODE.some((re) => re.test(path));
const docOrTest = (path: string): boolean => DOC_OR_TEST.some((re) => re.test(path));
const rank = (depth: Depth): number => DEPTHS.indexOf(depth);

/** The deeper of two depths: what a reviewer's own reading may do to the order's, and the only thing it may do. */
export const raiseDepth = (given: Depth, requested: Depth): Depth => (rank(requested) > rank(given) ? requested : given);

/** The one line the reviewer's order carries. */
export const depthLine = (depth: Depth): string => `Review depth: ${depth}${depth === "full" ? " (a risky path: read every changed line)" : ""}. You may raise it, never lower it.`;

/** The first path that sends this diff to `full`, or `undefined`. */
export function fullByCode({ paths, closesPaths = [] }: Pick<DepthState, "paths" | "closesPaths">): string | undefined {
  return [...paths, ...closesPaths].find(gateBearing);
}

const YES_NO = { yes: "it is so.", no: "it is not so." } as const;
const QUESTIONS: Record<string, Question> = {
  docsOrTestsOnly: { type: "choice", instructions: "Do the changed paths hold only documentation or tests, with no code that runs?", criteria: YES_NO, fallback: "no" },
  changesBehaviour: { type: "choice", instructions: "Does this change alter behaviour that a caller of the code observes?", criteria: YES_NO, fallback: "yes" },
  deletesCode: { type: "choice", instructions: "Does this change mainly delete code, rather than add or alter it?", criteria: YES_NO, fallback: "no" },
};

const trimmed = (s: DepthState) => ({
  paths: s.paths.slice(0, MAX_PATHS).map((p) => p.slice(0, MAX_TEXT)),
  pathCount: s.paths.length,
  added: s.added,
  removed: s.removed,
  title: s.title.slice(0, MAX_TEXT),
});

/** Light only when the provider says docs or tests only AND no observable change; a deletion that changes behaviour is the risky case. Code, not the provider, composes the depth. */
function compose(a: Record<"docsOrTestsOnly" | "changesBehaviour" | "deletesCode", unknown>): Depth {
  if (a.docsOrTestsOnly === "yes" && a.changesBehaviour === "no") return "light";
  if (a.changesBehaviour === "yes" && a.deletesCode === "yes") return "full";
  return "normal";
}

/** A claim the provider cannot make: it says docs-only of a diff that holds a path code knows is not. The answer is dropped, so the depth falls to `normal`. */
const contradicted = (state: DepthState, docsOrTestsOnly: unknown): boolean => docsOrTestsOnly === "yes" && !state.paths.every(docOrTest);

/**
 * HOW HARD SHOULD THE REVIEWER LOOK? Never throws; asks nobody for a path code already made `full`.
 */
export async function reviewDepth(state: DepthState, deps: DecisionDeps): Promise<ReviewDepth> {
  const risky = fullByCode(state);
  if (risky !== undefined) {
    if (deps.id !== undefined) recordOutcome(USE, deps.id, "full-by-code", deps);
    return { depth: "full", by: "code", reason: `${risky} is a gate-bearing path` };
  }
  const decision = await decide(USE, trimmed(state), QUESTIONS, deps);
  const answers = Object.fromEntries(Object.entries(decision.answers).map(([name, a]) => [name, a.value])) as Parameters<typeof compose>[0];
  // Low confidence, a refusal or a missing provider on ANY question is `normal`: a router that is unsure must not lighten a review.
  if (decision.via === "none" || decision.fellBack) return { depth: "normal", by: "none", reason: decision.reason ?? "a question fell back, so the depth is normal" };
  if (contradicted(state, answers.docsOrTestsOnly)) return { depth: "normal", by: "none", reason: "the provider said docs or tests only of a diff that holds other paths" };
  return { depth: compose(answers), by: "jev", reason: "answered by the provider" };
}

// ---------------------------------------------------------------------------------------------------
// THE STATE AND THE EFFORT (#4888).

/** `gh pr`'s `files` endpoint pages at 100; a diff past that has paths this read did not see, so it is not read at all. */
const FILES_PAGE = 100;
/** A row a body closes, in the full form a pull request is held to (`Closes a11ign/a11ign#4888`, #2995) or the bare `#n`, which is a row of the pull request's OWN repository. */
const CLOSES = /\bcloses?:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;

/** The effort a reviewer of this depth is STARTED with, or `undefined` for the profile's own: `light` is low, `normal` is the profile's, `full` is high. */
export function depthEffort(depth: Depth | undefined): string | undefined {
  if (depth === "light") return "low";
  return depth === "full" ? "high" : undefined;
}

/** The paths a row's Region names, without the repository prefix (`agent-org:src/x.ts` is `src/x.ts`). */
const regionPaths = (body: string): string[] => regionEntries(body).map((entry) => splitRegionEntry(entry).path);

/**
 * WHAT THE DIFF IS, or `null` when it could not be read whole. `null` is "could not determine", and the caller then asks nobody and sends today's order: a diff whose files or closed rows
 * were not all read could hide the one gate-bearing path that makes it `full`, and the provider must never be asked to lighten a review it has seen part of.
 */
export function readDepthState({ repo, number }: { repo: string; number: number }, gh: Gh): DepthState | null {
  const pull = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}`]));
  if (Number(pull.changed_files) > FILES_PAGE) return null;
  const files: { filename: string }[] = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}/files?per_page=${FILES_PAGE}`]));
  const closed = [...String(pull.body ?? "").matchAll(CLOSES)].map((match) => `${match[1] ?? repo}/issues/${match[2]}`);
  const closesPaths = [...new Set(closed)].flatMap((row) => regionPaths(String(JSON.parse(gh(["api", `repos/${row}`])).body ?? "")));
  return { paths: files.map((file) => file.filename), added: Number(pull.additions), removed: Number(pull.deletions), title: String(pull.title ?? ""), closesPaths };
}
