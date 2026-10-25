// @ts-check
// module: the shape of a worker's outcome file -- what the Stop hook checks before a worker may stop, what the pool reads from it, and the examples the brief shows

import { parseUntil, parseWaits } from "./wait-on/wait-parse.ts";
import { declaredRemains, type ProposedEdit, type PullRequest, type WrittenOutcome } from "./queue/queue-entries-and-outcomes.ts";

/** Every kind a worker's outcome file may name: the run kinds' outcomes, and the publish and new-ticket runs' own (A11-118). */
export const OUTCOME_KINDS = ["ready-pr", "draft-pr", "done", "checked", "wrong-repo", "needs-human", "working", "planned", "reviewed", "published", "drafted"] as const;

/** One kind a worker's outcome file may name. */
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** What a file may hold once it is read: an outcome the pool records, or the publish and new-ticket runs' kinds, which their own readers use. */
export type CheckedOutcome = WrittenOutcome | Readonly<{ kind: "published" }> | Readonly<{ kind: "drafted" }>;

/**
 * The result of checking a file. `ok` and `exact` is what the contract asks. `ok` without `exact` is the near miss, which the pool accepts and the
 * Stop hook refuses: it carries the `problem` the hook names. `!ok` carries the problem the same way. PURE.
 */
export type Checked =
  | Readonly<{ ok: true; exact: true; outcome: CheckedOutcome }>
  | Readonly<{ ok: true; exact: false; outcome: CheckedOutcome; problem: string }>
  | Readonly<{ ok: false; problem: string }>;

/** The field every kind may carry beside its own: the plan step the worker is on (A11-219). */
const STEP_KEY = "currentStep";

/** The fields a pull request outcome's contract names, and the one a near miss may carry instead of `prs`. */
const PULL_KEYS = ["prs", "reason", "partial", STEP_KEY];

/** The fields a reason-bearing outcome's contract names: its reason, and the edit a kind may carry. */
const REASON_KEYS = ["reason", "edit", STEP_KEY];

/** The fields a `working` outcome's contract names beside its reason: what it waits on (a job, or the events the board reads) and the time it expects to be woken by (A11-236, A11-245). */
const WORKING_KEYS = ["reason", "waitingOn", "until", STEP_KEY];

/** The kinds that may carry a proposed edit (A11-91): the three in which the worker has read its ticket closely. */
const EDIT_KINDS: ReadonlySet<string> = new Set(["done", "checked", "needs-human"]);

/** The longest title a worker may propose for its ticket, in characters (A11-91). */
const TITLE_CHARS = 255;

/** The longest description a worker may propose for its ticket, in characters (A11-91). */
const DESCRIPTION_CHARS = 60_000;

/** A GitHub pull request's address, with its owner and repository: the repository a near miss is given. */
const PULL_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+(?:[/?#]\S*)?$/;

/** One complete, concrete example of each outcome a worker may write, held to {@link checkOutcome} by a test (A11-118). */
export const OUTCOME_EXAMPLES: Readonly<Record<OutcomeKind, Readonly<Record<string, unknown>>>> = {
  "ready-pr": { kind: "ready-pr", prs: [{ repo: "example/app", url: "https://github.com/example/app/pull/1" }], reason: "Opened the pull request; its checks are running." },
  "draft-pr": { kind: "draft-pr", prs: [{ repo: "example/app", url: "https://github.com/example/app/pull/1" }], reason: "Opened the pull request as a draft." },
  done: { kind: "done", reason: "The ticket asks for one new test; it is on main and every Done-when item holds.", evidence: ["pnpm test: the new case passes, 12 of 12"] },
  checked: { kind: "checked", reason: "Read the ticket and the code it names: the change is already on main, so nothing needs to change, and the ticket waits for a person to close it." },
  "wrong-repo": { kind: "wrong-repo", where: "a11ign/screenreader-worker: the scheduler that fails this run lives there, not in this repository." },
  "needs-human": { kind: "needs-human", reason: "The one thing only a person can decide, and why the evidence does not settle it: the ticket asks for both behaviours and names no winner." },
  working: { kind: "working", reason: "The capture is running on the fleet; the board prompts me when job fj-2026-1025-a ends.", waitingOn: [{ fleetJob: "fj-2026-1025-a" }] },
  planned: { kind: "planned" },
  reviewed: { kind: "reviewed" },
  published: { kind: "published" },
  drafted: { kind: "drafted" },
};

/** The brief's line for each example: a JSON object on one line, as the brief's outcome block shows it. PURE. */
const exampleLine = (example: Readonly<Record<string, unknown>>): string =>
  `{ ${Object.entries(example).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")} }`;

/** The example lines of the kinds a brief may have its worker write, one per line. PURE. */
export const outcomeExamples = (kinds: readonly OutcomeKind[]): string => kinds.map((kind) => exampleLine(OUTCOME_EXAMPLES[kind])).join("\n");

/**
 * Whether an outcome file written at `mtime` (ms) is stale under `mark`, the time its run was marked stale: a file at or before the mark is the one the run
 * parked on, so it is no outcome. No mark makes nothing stale, and a mark that is not a number makes everything stale (A11-152). PURE.
 */
export const isStale = (mtime: number, mark: string | undefined): boolean => mark !== undefined && !(mtime > Number.parseFloat(mark));

/** Whether a value is text with something in it: the shape every named string field must have. */
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Whether a value is a JSON object, not a list, a string or null. */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value names one of {@link OUTCOME_KINDS}. */
const isKind = (value: unknown): value is OutcomeKind => (OUTCOME_KINDS as readonly unknown[]).includes(value);

/** Whether a value is a plan step's number: a whole number of 1 or more. */
const isStepNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/** What a file with a `currentStep` that is no plan step's number is refused with: the number it wrote as written, or what else it wrote. PURE. */
function stepProblem(written: unknown): string {
  const wroteAs = typeof written === "number" || typeof written === "string" ? JSON.stringify(written) : wrote(written);
  return `${STEP_KEY} needs a whole number of 1 or more, the number of the plan step you are on, you wrote ${wroteAs}`;
}

/**
 * The plan step a worker's outcome file says it is on (A11-219), or null when the file is no JSON object, writes none, or writes one that is not a whole number of 1 or more: the board
 * records what the worker wrote, and `checkOutcome` is what refuses the rest. PURE over the file's text.
 */
export function writtenStep(text: string): number | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) && isStepNumber(value[STEP_KEY]) ? value[STEP_KEY] : null;
  } catch {
    return null;
  }
}

/** A refusal, with the problem the Stop hook names and the pool records. PURE. */
const refuse = (problem: string): Checked => ({ ok: false, problem });

/** An accepted outcome that meets the contract exactly. PURE. */
const accept = (outcome: CheckedOutcome): Checked => ({ ok: true, exact: true, outcome });

/** What a value is, as a refusal names it: a list, a string, an empty string, or its type. PURE. */
function wrote(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty list" : "a list";
  if (typeof value === "string") return value.trim() === "" ? "an empty string" : "a string";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * What a file wrote where the contract wants `key`: the value it holds, or the keys it has beyond the contract's (`known`), or that it has none of
 * those. The contract's keys are never named as extra. PURE.
 */
function wroteInstead(object: Record<string, unknown>, key: string, known: readonly string[]): string {
  if (key in object) return `you wrote ${wrote(object[key])}`;
  const extra = Object.keys(object).filter((name) => name !== "kind" && !known.includes(name));
  return extra.length > 0 ? `you wrote ${extra.join(", ")}` : `you wrote no ${key}`;
}

/** Whether a title is one line of 1 to {@link TITLE_CHARS} characters, as the board writes it (A11-91). PURE. */
const fitsTitle = (title: unknown): title is string => typeof title === "string" && title.trim() !== "" && title.length <= TITLE_CHARS && !title.includes("\n");

/** Whether a description is text of up to {@link DESCRIPTION_CHARS} characters (A11-91). PURE. */
const fitsDescription = (description: unknown): description is string => typeof description === "string" && description.length <= DESCRIPTION_CHARS;

/**
 * The edit a worker proposed on its outcome, read once: the title and description it proposes and why, or why it is not one the board can apply
 * (A11-91): an object with a `why`, and a title or a description, or both. PURE.
 */
export function readEdit(edit: unknown): ProposedEdit | string {
  if (!isObject(edit)) return "is not an object";
  const { title, description, why } = edit;
  if (typeof why !== "string" || why.trim() === "") return "has no why";
  const proposed: { title?: string; description?: string; why: string } = { why };
  if (title !== undefined) {
    if (!fitsTitle(title)) return `proposes a title that is not one line of 1 to ${TITLE_CHARS} characters`;
    proposed.title = title;
  }
  if (description !== undefined) {
    if (!fitsDescription(description)) return `proposes a description of more than ${DESCRIPTION_CHARS.toLocaleString("en-US")} characters`;
    proposed.description = description;
  }
  return proposed.title === undefined && proposed.description === undefined ? "proposes neither a title nor a description" : proposed;
}

/** The outcome field that carries a proposed edit, or nothing when the worker proposed none (A11-91). PURE. */
const editField = (edit: ProposedEdit | undefined): Readonly<{ edit?: ProposedEdit }> => (edit === undefined ? {} : { edit });

/** A pull request outcome's `partial` declaration, what remains of the ticket, when the worker wrote one (A11-92). PURE. */
const partialOf = (value: Readonly<Record<string, unknown>>): { partial?: string } => {
  const remains = typeof value.partial === "string" ? declaredRemains(value.partial) : null;
  return remains === null ? {} : { partial: remains };
};

/** A pull request outcome of the kind its file named. PURE. */
const pullOutcome = (kind: "ready-pr" | "draft-pr", prs: readonly PullRequest[], object: Readonly<Record<string, unknown>>): WrittenOutcome => ({ kind, prs, ...partialOf(object) });

/**
 * A `ready-pr` or `draft-pr`: `prs` is a non-empty list of `{repo, url}`, each with text in both. A `pr` string that is a GitHub pull request address
 * is the near miss: accepted by the pool as one pull request, refused by the hook. PURE.
 */
function pullRequests(kind: "ready-pr" | "draft-pr", object: Record<string, unknown>): Checked {
  const want = `${kind} needs prs: [{repo, url}]`;
  const { prs } = object;
  if (prs === undefined) {
    if (typeof object.pr !== "string") return refuse(`${want}, ${wroteInstead(object, "prs", PULL_KEYS)}`);
    const problem = `${want}, you wrote pr`;
    const match = PULL_URL.exec(object.pr);
    if (match === null) return refuse(`${problem}, which is not a GitHub pull request address`);
    return { ok: true, exact: false, outcome: pullOutcome(kind, [{ repo: match[1] ?? "", url: object.pr }], object), problem };
  }
  if (!Array.isArray(prs)) return refuse(`${want}, you wrote ${wrote(prs)}`);
  if (prs.length === 0) return refuse(`${want}, you wrote an empty list`);
  const pulls: PullRequest[] = [];
  for (const [index, item] of prs.entries()) {
    const at = `${kind} prs[${index}]`;
    if (!isObject(item)) return refuse(`${at} needs {repo, url}, you wrote ${wrote(item)}`);
    const { repo, url } = item;
    if (!nonEmpty(repo)) return refuse(`${at} needs repo: a string, ${wroteInstead(item, "repo", ["repo", "url"])}`);
    if (!nonEmpty(url)) return refuse(`${at} needs url: a string, ${wroteInstead(item, "url", ["repo", "url"])}`);
    pulls.push({ repo, url });
  }
  return accept(pullOutcome(kind, pulls, object));
}

/** A `checked` or `needs-human`: a non-empty `reason` the file's contract names, beside the `edit` a kind may carry. PURE. */
function withReason(kind: OutcomeKind, object: Record<string, unknown>, outcome: (reason: string) => CheckedOutcome): Checked {
  const { reason } = object;
  return nonEmpty(reason) ? accept(outcome(reason)) : refuse(`${kind} needs reason: a string, ${wroteInstead(object, "reason", REASON_KEYS)}`);
}

/**
 * A `working`: a non-empty `reason`, and optionally `waitingOn` and `until`, the ISO time the board reads as the bound of the wait (A11-236). `waitingOn` is a string naming background work the worker's own shell or
 * Monitor holds (an undeclared wait), or a list of the events the board reads for it (A11-245: a declared wait, checked by `parseWaits`). A plain `working` with a reason alone is still valid. PURE.
 */
function workingOutcome(object: Record<string, unknown>): Checked {
  const { reason, waitingOn, until } = object;
  if (!nonEmpty(reason)) return refuse(`working needs reason: a string, ${wroteInstead(object, "reason", WORKING_KEYS)}`);
  const waits = Array.isArray(waitingOn) ? parseWaits(waitingOn) : undefined;
  if (typeof waits === "string") return refuse(`working ${waits}`);
  if (waitingOn !== undefined && waits === undefined && !nonEmpty(waitingOn)) return refuse(`working waitingOn needs a string naming the background job or a list of the events to wait on, you wrote ${wrote(waitingOn)}`);
  const deadline = until === undefined ? undefined : parseUntil(until);
  if (typeof deadline === "string") return refuse(`working ${deadline}`);
  const named = waits === undefined && typeof waitingOn === "string" ? { waitingOn: waitingOn.trim() } : {};
  return accept({ kind: "working", reason, ...named, ...(waits === undefined ? {} : { waits }), ...(deadline === undefined ? {} : { until: deadline }) });
}

/**
 * A `done`: a reason, and evidence with one non-empty line per Done-when item (ADR 0021/0047: a prediction never fills an evidence field). PURE.
 */
function doneOutcome(object: Record<string, unknown>, edit: ProposedEdit | undefined): Checked {
  const known = ["reason", "evidence", "edit", STEP_KEY];
  const { reason, evidence } = object;
  if (!nonEmpty(reason)) return refuse(`done needs reason: a string, ${wroteInstead(object, "reason", known)}`);
  if (!Array.isArray(evidence)) return refuse(`done needs evidence: a list of lines, one per Done-when item, ${wroteInstead(object, "evidence", known)}`);
  if (evidence.length === 0) return refuse("done needs evidence: a list of lines, one per Done-when item, you wrote an empty list");
  const lines: unknown[] = evidence;
  const blank = lines.findIndex((line) => !nonEmpty(line));
  if (blank !== -1) return refuse(`done evidence[${blank}] needs a non-empty line, you wrote ${wrote(lines[blank])}`);
  return accept({ kind: "done", reason: reason.trim(), evidence: lines.filter(nonEmpty).map((line) => line.trim()), ...editField(edit) });
}

/**
 * Whether a file's text is an outcome the contract accepts, and the outcome it is. A refusal names the field the contract wants, and what the file
 * wrote in its place, so the worker can fix it: the Stop hook shows that text and the pool records it. PURE over the file's text.
 */
export function checkOutcome(text: string): Checked {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return refuse(`the file is not JSON: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
  }
  if (Array.isArray(value)) return refuse("the file holds an array; it must be one object");
  if (!isObject(value)) return refuse("the file must hold one object");
  const { kind } = value;
  if (!isKind(kind)) {
    return refuse(kind === undefined ? `the file has no "kind": write one of ${OUTCOME_KINDS.join(", ")}` : `kind ${JSON.stringify(kind)} is not one of ${OUTCOME_KINDS.join(", ")}`);
  }
  if (value[STEP_KEY] !== undefined && !isStepNumber(value[STEP_KEY])) return refuse(stepProblem(value[STEP_KEY]));
  const edit = EDIT_KINDS.has(kind) && value.edit !== undefined ? readEdit(value.edit) : undefined;
  if (typeof edit === "string") return refuse(`${kind} edit ${edit}`);
  switch (kind) {
    case "ready-pr":
    case "draft-pr":
      return pullRequests(kind, value);
    case "done":
      return doneOutcome(value, edit);
    case "checked":
    case "needs-human":
      return withReason(kind, value, (reason) => ({ kind, reason, ...editField(edit) }));
    case "working":
      return workingOutcome(value);
    case "wrong-repo":
      return nonEmpty(value.where) ? accept({ kind, where: value.where }) : refuse(`wrong-repo needs where: a string, ${wroteInstead(value, "where", ["where", STEP_KEY])}`);
    case "reviewed":
      // A review run's pull requests are the ones the person approved, which the pool holds: `settle` puts them in.
      return accept({ kind, prs: [] });
    case "planned":
    case "published":
    case "drafted":
      return accept({ kind });
  }
}
