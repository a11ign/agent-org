#!/usr/bin/env node
// @ts-check
// command: ticket:hook -- the Stop and PreToolUse hook every ticket-mode worker runs under: `ticket:hook stop|pre-tool-use <ticket dir>`
//
// STOP: A RUN ENDS ON AN OUTCOME FILE. A worker that stops without writing one leaves the board with nothing to show, so the stop is refused with
// the file's path, at most twice in a row, after which it is allowed and the pool records `no-outcome`. It does NOT honour `stop_hook_active`, as
// `worker-stop-hook.ts` does: the nbl-ui plugin's own Stop gates block once and then let the next stop through on that flag, and a hook that also
// honoured it would let a worker end on that second stop with no outcome. Its own count is what bounds it.
//
// A `working` OUTCOME LETS ONE STOP THROUGH (A11-80). A worker whose own background work runs on writes `{ "kind": "working", ... }` and ends its
// turn; the pool keeps the run running. When that work wakes it, the file still says `working`, so a stop on the SAME file (the time recorded in
// `working-stop` when it was let through) is refused like a missing outcome, with the same count: the worker says how the run stands now, or
// writes `working` again while more of its work is running.
//
// PRE-TOOL-USE: WHAT ONLY A PERSON DOES. A worker opens a DRAFT pull request, links it into a stack with `gh stack link` when its brief says so,
// and stops. Marking it ready, requesting a review, merging, force-pushing, running a workflow, posting to Slack and any other `gh stack`
// command are the person's, and so is every connector the machine does not name. A worker runs with the person's
// connectors, Slack and mail among them, so a connector is refused unless the host file's `tickets.connectors` lets its tool name through: a
// machine whose tickets live in Linear names Linear's reads, and its worker can read a ticket's parent and blockers there. The host file's
// `tickets.deny` adds this machine's own command refusals. The pool copies both beside the outcome file. A refusal is exit 2 with the reason on
// stderr, which Claude Code hands back to the model. A REVIEW RUN, which a person started by approving the pull requests, may mark THOSE
// pull requests ready: the pool leaves `review-run` beside the outcome file naming them, no worker may write it, and nothing else of the
// person's is lifted. A PUBLISH RUN, which a person started by pressing Publish, may run the `post-pr-to-slack` skill and call the connectors
// the host file's `tickets.publish.connectors` names: the pool leaves `publish-run` beside its outcome file naming them, which no worker may
// write either, and merging, reviewing, force-pushing and running a workflow stay refused.
//
// On a machine with `tickets.drafts: false` the pool leaves `ready-run` beside the outcome file, and a worker may open its pull request ready
// (`gh pr create` without `--draft`) only then. Without that mark, the draft refusal applies to every run, as before. No worker may write the mark.
//
// A PRE-PR REVIEW GATE (A11-86). On a machine whose `tickets.prReview` names a skill, a push or a pull request is refused until that skill has run
// since the worker's last commit. The hook keeps that order in an append-only log beside the outcome file, `pr-review-log`: a `review` line for each
// call of the skill and a `commit` line for each git commit that makes one. The gate allows a push or a pull request only when the log's last line
// is `review`. Absent the setting, nothing is logged and nothing is refused on a review.
//
// IT FAILS OPEN, OUT LOUD, for a payload or a count it cannot read: a hook that refused on what it could not read would stop every worker.
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DenyRule } from "./settings.ts";
import { CONNECTORS_FILE, DENY_FILE, OUTCOME_FILE, PUBLISH_FILE, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, READY_FILE, REVIEW_FILE, STOP_COUNT_FILE,
  WORKING_STOP_FILE } from "./worker-files.ts";

export type HookResult = Readonly<{ code: 0 | 2; say: readonly string[] }>;

export const MAX_STOP_REFUSALS = 2;

const ALLOW: HookResult = { code: 0, say: [] };
const refuse = (reason: string): HookResult => ({ code: 2, say: [`ticket-mode: ${reason}`] });

type Refusal = Readonly<{ pattern: RegExp; why: string }>;

/** Each command a ticket-mode worker may not run, and why. Matched against the Bash tool's whole command line. */
const BASH_REFUSALS: readonly Refusal[] = [
  { pattern: /\bgh\s+pr\s+(merge|review)\b/, why: "merging and reviewing are the person's" },
  { pattern: /--add-reviewer\b|--reviewer\b/, why: "requesting a review is the person's" },
  { pattern: /\bgh\s+workflow\s+run\b/, why: "running a workflow is the person's" },
  { pattern: /\bgit\s+push\b[^\n;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/, why: "a force push rewrites what someone may have read" },
  { pattern: /\bassumego\b/, why: "it prints credentials into the session" },
  // `gh stack link` only records which pull request a worker's sits on. Every other subcommand pushes, rebases or merges a whole stack. The
  // contract allows the literal `gh stack link` alone, so the extension's other spellings (`gh extension exec stack`, `gh-stack`) are refused
  // whatever follows them.
  { pattern: /\bgh\s+stack\b(?!\s+link\b)|\bgh\s+extension\s+exec\s+stack\b|\bgh-stack\b/,
    why: "a stack's pushes, rebases and merges are the person's: a worker runs only `gh stack link`" },
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Marking a pull request ready is the person's, until they approve it on the board: then a review run may mark the pull requests they
 * approved, each named by its URL, and never undo one.
 */
function readyRefusal(approved: readonly string[]): Refusal {
  const named = approved.length === 0 ? "" : `(?![^\\n;&|]*(?:${approved.map(escape).join("|")})(?![\\w/]))`;
  return { pattern: new RegExp(`\\bgh\\s+pr\\s+ready\\b${named}|\\bgh\\s+pr\\s+ready\\b[^\\n;&|]*--undo\\b`),
    why: "marking a pull request ready is the person's, except a review run's own approved pull requests, by URL" };
}

/** The review and publish marks are the board's: a worker that wrote one would lift a refusal. */
const MARK_REFUSAL: Refusal = { pattern: new RegExp(`\\b(?:${REVIEW_FILE}|${PUBLISH_FILE}|${READY_FILE})\\b`),
  why: `${REVIEW_FILE}, ${PUBLISH_FILE} and ${READY_FILE} are the board's to write` };
/**
 * The pre-PR review's files, the hook's log and the pool's copy of the setting. Only the gate refuses them, and only when the setting is named, so a machine
 * without it is unchanged (A11-86).
 */
const PR_REVIEW_FILE_REFUSAL: Refusal = { pattern: new RegExp(`\\b(?:${[PR_REVIEW_FILE, PR_REVIEW_LOG_FILE].map(escape).join("|")})\\b`),
  why: `${PR_REVIEW_FILE} and ${PR_REVIEW_LOG_FILE} are the pool's and the hook's: a worker may not write them, nor name them in a command` };
const FILE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const SKILL_REFUSALS: readonly Refusal[] = [
  { pattern: /post-pr-to-slack/, why: "announcing a pull request is the person's" },
];

/**
 * The PreToolUse verdict for one tool call. `machine` holds this machine's own Bash refusals, after the built-in ones, and `connectors` the
 * connector tool names it allows. `approved` names the pull requests a review run may mark ready, by URL: none for any other run. `publish`
 * holds the connector tool names a publish run may call as well, and is null for any other run, which may not announce a pull request. `ready` is
 * true for a run on a machine with `tickets.drafts: false`, which may open its pull request ready rather than as a draft. PURE.
 */
export function toolVerdict(toolName: string, input: Record<string, unknown>, machine: readonly Refusal[] = [], connectors: readonly RegExp[] = [],
  approved: readonly string[] = [], publish: readonly RegExp[] | null = null, ready = false): HookResult {
  if (toolName.startsWith("mcp__")) {
    const allowed = [...connectors, ...(publish ?? [])];
    return allowed.some((pattern) => pattern.test(toolName)) ? ALLOW : refuse(`${toolName} is a connector this machine's tickets.connectors does not allow`);
  }
  if (toolName === "Skill") {
    const skill = String(input.skill ?? input.name ?? "");
    const hit = publish === null ? SKILL_REFUSALS.find(({ pattern }) => pattern.test(skill)) : undefined;
    return hit ? refuse(`the ${skill} skill is refused: ${hit.why}`) : ALLOW;
  }
  if (FILE_TOOLS.has(toolName)) return MARK_REFUSAL.pattern.test(String(input.file_path ?? input.notebook_path ?? "")) ? refuse(MARK_REFUSAL.why) : ALLOW;
  if (toolName !== "Bash") return ALLOW;
  const command = String(input.command ?? "");
  if (/\bgh\s+pr\s+create\b/.test(command) && !/--draft\b/.test(command) && !ready) return refuse("open the pull request as a draft: `gh pr create --draft`");
  const hit = [...BASH_REFUSALS, readyRefusal(approved), MARK_REFUSAL, ...machine].find(({ pattern }) => pattern.test(command));
  return hit ? refuse(`refused, because ${hit.why}: ${command.split("\n")[0].slice(0, 120)}`) : ALLOW;
}

/**
 * This machine's refusals, from the copy of `tickets.deny` beside the outcome file. None when there is no copy. A copy it cannot read is
 * reported and skipped, so the built-in refusals still apply.
 */
export function machineRefusals(ticketDir: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): { refusals: readonly Refusal[]; note?: string } {
  const file = join(ticketDir, DENY_FILE);
  try {
    const rules = JSON.parse(read(file)) as DenyRule[];
    return { refusals: rules.map(({ pattern, reason }) => ({ pattern: new RegExp(pattern), why: reason })) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { refusals: [] };
    return { refusals: [], note: `ticket:hook: could not read ${file}, so only the built-in refusals apply.` };
  }
}

/**
 * The connector tool names this machine allows, from the copy of `tickets.connectors` beside the outcome file. None when there is no copy, so
 * every connector is refused. A copy it cannot read is reported and allows none.
 */
export function machineConnectors(ticketDir: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): { connectors: readonly RegExp[]; note?: string } {
  const file = join(ticketDir, CONNECTORS_FILE);
  try {
    return { connectors: (JSON.parse(read(file)) as string[]).map((pattern) => new RegExp(pattern)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { connectors: [] };
    return { connectors: [], note: `ticket:hook: could not read ${file}, so every connector is refused.` };
  }
}

/** The pull requests a review run may mark ready, from the board's review mark beside the outcome file. None when there is no mark, or none it can read. */
export function approvedPulls(ticketDir: string): string[] {
  const file = join(ticketDir, REVIEW_FILE);
  if (!existsSync(file)) return [];
  try {
    const prs = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(prs) ? prs.map((pr) => String((pr as { url?: unknown })?.url ?? "")).filter((url) => url !== "") : [];
  } catch {
    return [];
  }
}

/**
 * The connector tool names a publish run may call, from the board's publish mark beside the outcome file, or null when there is no mark, or
 * none it can read: then the run is no publish run.
 */
export function publishConnectors(ticketDir: string): RegExp[] | null {
  const file = join(ticketDir, PUBLISH_FILE);
  if (!existsSync(file)) return null;
  try {
    const { connectors } = JSON.parse(readFileSync(file, "utf8")) as { connectors?: unknown };
    return Array.isArray(connectors) ? connectors.map((pattern) => new RegExp(String(pattern))) : null;
  } catch {
    return null;
  }
}

/** git's options that take their value as the next word, such as `git -C <dir>` and `git --work-tree <dir>`. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
/** The git subcommands that make a commit, or bring one in: a push after one of them would send what no review has seen. */
const COMMIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["commit", "merge", "rebase", "cherry-pick", "am", "revert", "pull"]);

/**
 * The git subcommand each `git` in a command runs, after git's own options. A command is read twice, once as written and once with its quotes taken
 * off, so `bash -c 'git push'` is found as well. A word only searched for, as in `git grep commit`, is not one. PURE.
 */
export function gitSubcommands(command: string): string[] {
  return [...subcommandsIn(command), ...subcommandsIn(command.replace(/["']/g, ""))];
}

function subcommandsIn(text: string): string[] {
  const found: string[] = [];
  for (const segment of text.split(/&&|\|\||[;|&\n()`]/)) {
    const words = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    words.forEach((word, i) => {
      if (!/^(?:\S*\/)?git$/.test(word)) return;
      let next = i + 1;
      while (next < words.length && words[next].startsWith("-")) next += GIT_VALUE_OPTIONS.has(words[next]) ? 2 : 1;
      found.push(words[next] ?? "");
    });
  }
  return found;
}
const PULL_REQUEST = /\bgh\s+pr\s+create\b|\bpr:open\s+create\b/;

/**
 * What a tool call means to the pre-PR review gate: `review` when it runs the configured skill, `commit` when it is a git command that makes a commit,
 * and null for any other call. A skill named with a leading `/` is the same skill. PURE.
 */
export function prReviewEvent(toolName: string, input: Record<string, unknown>, skill: string): "review" | "commit" | null {
  if (toolName === "Skill") return String(input.skill ?? input.name ?? "").replace(/^\//, "") === skill ? "review" : null;
  return toolName === "Bash" && gitSubcommands(String(input.command ?? "")).some((subcommand) => COMMIT_SUBCOMMANDS.has(subcommand)) ? "commit" : null;
}

/**
 * The gate's refusal for a Bash command that would open a pull request or push, or null when it may run. It may run only when the log's last event is
 * `review` and the command makes no commit itself: `git commit ... && git push` would push what the review never saw. PURE.
 */
export function prReviewRefusal(command: string, log: readonly string[], skill: string): string | null {
  const subcommands = gitSubcommands(command);
  const commits = subcommands.some((subcommand) => COMMIT_SUBCOMMANDS.has(subcommand));
  if (!PULL_REQUEST.test(command) && !subcommands.includes("push")) return null;
  if (log[log.length - 1] === "review" && !commits) return null;
  const why = commits ? "this command commits, so the skill cannot have reviewed what it pushes: commit first, run the skill, then push"
    : `it has not run since your last commit`;
  return `run the \`${skill}\` skill on your whole diff before you push or open a pull request: ${why}. Fix what it finds, re-run the tests, commit, and run it again until it finds nothing.`;
}

/**
 * The pre-PR review skill from the copy of `tickets.prReview` beside the outcome file, or null when there is no copy. A copy it cannot read, or one that
 * names no skill, is reported and skipped, so the gate does not apply: the hook never refuses on what it cannot read.
 */
export function prReviewSetting(ticketDir: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): { skill: string | null; note?: string } {
  const file = join(ticketDir, PR_REVIEW_FILE);
  try {
    const skill = JSON.parse(read(file)) as unknown;
    return typeof skill === "string" && skill !== "" ? { skill } : { skill: null, note: `ticket:hook: ${file} names no skill, so the pre-PR review is not enforced.` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { skill: null };
    return { skill: null, note: `ticket:hook: could not read ${file}, so the pre-PR review is not enforced.` };
  }
}

/**
 * The gate for a tool call the other refusals allowed: a push or a pull request is refused unless the review has run since the last commit, and an allowed
 * call that is a review or a commit is logged, one line, so parallel calls cannot lose one. A log it cannot read or write allows the call, out loud.
 */
function prReviewGate(toolName: string, input: Record<string, unknown>, ticketDir: string, skill: string): HookResult {
  const log = join(ticketDir, PR_REVIEW_LOG_FILE);
  try {
    const target = toolName === "Bash" ? String(input.command ?? "") : FILE_TOOLS.has(toolName) ? String(input.file_path ?? input.notebook_path ?? "") : "";
    if (PR_REVIEW_FILE_REFUSAL.pattern.test(target)) return refuse(PR_REVIEW_FILE_REFUSAL.why);
    const events = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
    const refusal = toolName === "Bash" ? prReviewRefusal(String(input.command ?? ""), events, skill) : null;
    if (refusal !== null) return refuse(refusal);
    const event = prReviewEvent(toolName, input, skill);
    if (event !== null) appendFileSync(log, `${event}\n`);
    return ALLOW;
  } catch (err) {
    return { code: 0, say: [`ticket:hook: could not read or write ${log} (${String((err as Error)?.message ?? err).split("\n")[0]}), so the pre-PR review is not enforced for this call.`] };
  }
}

/** Whether an outcome file's text is a `working` outcome. Text that is not JSON is not one: the pool reads it as it reads any outcome. PURE. */
function isWorking(text: string): boolean {
  try {
    return (JSON.parse(text) as { kind?: unknown } | null)?.kind === "working";
  } catch {
    return false;
  }
}

/**
 * The Stop verdict: allowed once the outcome file is there, refused with its path otherwise, up to {@link MAX_STOP_REFUSALS} in a row. A `working`
 * outcome allows one stop; a later stop on the same file, by its time, is refused the same way, so a worker its background work woke says how
 * the run stands now.
 */
export function stopVerdict(ticketDir: string, { exists = existsSync, read = (p: string) => readFileSync(p, "utf8"), write = (p: string, t: string) => writeFileSync(p, t),
  mtime = (p: string) => statSync(p).mtimeMs }: {
  exists?: (path: string) => boolean; read?: (path: string) => string; write?: (path: string, text: string) => void; mtime?: (path: string) => number;
} = {}): HookResult {
  const outcome = join(ticketDir, OUTCOME_FILE);
  const counter = join(ticketDir, STOP_COUNT_FILE);
  const stamp = join(ticketDir, WORKING_STOP_FILE);
  let ask = `write ${outcome} before you stop, with one of the outcomes your brief lists, such as { "kind": "needs-human", "reason": "..." }.`;
  if (exists(outcome)) {
    const working = isWorking(read(outcome)) ? String(mtime(outcome)) : null;
    if (working === null || !exists(stamp) || read(stamp).trim() !== working) {
      if (working !== null) write(stamp, working);
      write(counter, "0");
      return ALLOW;
    }
    ask = `${outcome} still says working from before your background work woke you: write it again with how the run stands now, or with { "kind": "working", "reason": "..." } again if more of your own work is still running.`;
  }
  const refused = exists(counter) ? Number.parseInt(read(counter), 10) || 0 : 0;
  if (refused >= MAX_STOP_REFUSALS) {
    const what = exists(outcome) ? `on the same working outcome in ${outcome}, so this one is allowed and the board keeps the run in progress` : `without ${outcome}, so this one is allowed and the board records no outcome`;
    return { code: 0, say: [`ticket-mode: ${refused} stops in a row ${what}.`] };
  }
  write(counter, String(refused + 1));
  return refuse(ask);
}

export function main(stdin: string, argv: string[]): HookResult {
  const [event, ticketDir] = argv;
  if ((event !== "stop" && event !== "pre-tool-use") || !ticketDir) return { code: 0, say: [`ticket:hook: usage is ticket:hook stop|pre-tool-use <ticket dir>, so this call is ALLOWED.`] };
  try {
    if (event === "stop") return stopVerdict(ticketDir);
    const payload = JSON.parse(stdin) as { tool_name?: string; tool_input?: Record<string, unknown> };
    const tool = String(payload.tool_name ?? "");
    const input = payload.tool_input ?? {};
    const { refusals, note } = machineRefusals(ticketDir);
    const allowed = machineConnectors(ticketDir);
    const review = prReviewSetting(ticketDir);
    const verdict = toolVerdict(tool, input, refusals, allowed.connectors, approvedPulls(ticketDir), publishConnectors(ticketDir), existsSync(join(ticketDir, READY_FILE)));
    // A call the other refusals stopped is neither logged nor gated: it did not run.
    const gated = verdict.code === 0 && review.skill !== null ? prReviewGate(tool, input, ticketDir, review.skill) : verdict;
    const notes = [note, allowed.note, review.note].filter((n): n is string => n !== undefined);
    return notes.length === 0 ? gated : { ...gated, say: [...notes, ...gated.say] };
  } catch (err) {
    return { code: 0, say: [`ticket:hook: could not read the ${event} payload (${String((err as Error)?.message ?? err).split("\n")[0]}), so it is ALLOWED.`] };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    // no stdin reads as an empty payload
  }
  const { code, say } = main(stdin, process.argv.slice(2));
  if (say.length > 0) process.stderr.write(`${say.join("\n")}\n`);
  process.exit(code);
}
