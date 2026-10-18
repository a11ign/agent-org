#!/usr/bin/env node
// @ts-check
// command: ticket:hook -- the Stop and PreToolUse hook every ticket-mode worker runs under: `ticket:hook stop|pre-tool-use <ticket dir>`
//
// STOP: A RUN ENDS ON AN OUTCOME FILE. A worker that stops without writing one leaves the board with nothing to show, so the stop is refused with
// the file's path, at most twice in a row, after which it is allowed and the pool records `no-outcome`. It does NOT honour `stop_hook_active`, as
// `worker-stop-hook.ts` does: the nbl-ui plugin's own Stop gates block once and then let the next stop through on that flag, and a hook that also
// honoured it would let a worker end on that second stop with no outcome. Its own count is what bounds it.
//
// A `working` OUTCOME LETS ONE STOP THROUGH, AND ONLY WHILE SOMETHING WILL WAKE THE WORKER (A11-80, A11-85). A worker whose own background work runs on
// writes `{ "kind": "working", ... }` and ends its turn; the pool keeps the run running. The stop is let through only if the session's transcript
// (`transcript_path`, in the Stop payload) shows a background shell or Monitor still live (`background-work.ts`). With none, it is refused, so a
// worker that detached a process and waited on nothing is told to wait in the foreground or arm a Monitor on it. A transcript it cannot read is
// let through OUT LOUD, and the board's stall check is the backstop. When that work wakes it, the file still says `working`, so a stop on the SAME
// file (the time recorded in `working-stop` when it was let through) is refused like a missing outcome, with the same count: the worker says how the
// run stands now, or writes `working` again while more of its work is running.
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
// THE HOST'S OWN PROGRAMS (A11-84): a worker may not write the routing `gh` or the launcher `agent-org` in the host's bin directory, which the pool names in
// `protected-paths.json` beside the outcome file, and may not run `host:install` or any other command that installs them. The hook cannot see a TEST that writes
// the file, so this is defence in depth: the guarded writer (`writeGhWrapper`) is what keeps a test from writing it.
//
// On a machine with `tickets.drafts: false` the pool leaves `ready-run` beside the outcome file, and a worker may open its pull request ready
// (`gh pr create` without `--draft`) only then. Without that mark, the draft refusal applies to every run, as before. No worker may write the mark.
//
// IT FAILS OPEN, OUT LOUD, for a payload or a count it cannot read: a hook that refused on what it could not read would stop every worker.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { liveBackgroundWork } from "./background-work.ts";
import type { DenyRule } from "./settings.ts";
import { CONNECTORS_FILE, DENY_FILE, OUTCOME_FILE, PROTECTED_FILE, PUBLISH_FILE, READY_FILE, REVIEW_FILE, STOP_COUNT_FILE, WORKING_STOP_FILE, defaultBinDir, protectedPaths } from "./worker-files.ts";

export type HookResult = Readonly<{ code: 0 | 2; say: readonly string[] }>;

export const MAX_STOP_REFUSALS = 2;

const ALLOW: HookResult = { code: 0, say: [] };
const refuse = (reason: string): HookResult => ({ code: 2, say: [`ticket-mode: ${reason}`] });

/** What a `working` outcome is refused with when the session has no live background work to wake it (A11-85). */
const NOTHING_WAKES = "nothing is running that will wake you; wait in the foreground or arm a Monitor on the process (its PID or its log)";

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
const FILE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The commands that install the host's programs, which write its `gh` wrapper and launcher: the host's to run (A11-84). */
const HOST_INSTALL_REFUSAL: Refusal = { pattern: /(?:\b(?:pnpm|agent-org)\s+(?:run\s+)?|^\s*)host:install\b|\bhost:check\b[^\n;&|]*--install\b|\bhost-units\.ts\b[^\n;&|]*--install\b|\bhost(?:Identity|Units)Install\s*\(/,
  why: "installing the host's programs is the host's: `host:install` writes its gh wrapper and launcher" };

/**
 * A write to one of the host's programs (A11-84): a shell command that writes a path naming one, with its write verb before it. The path is matched as the command
 * names it: absolute, or under `~` or `$HOME`. A read of it (`cat`, `grep`, `ls`) and a longer name (`gh-real`, `agent-org-tickets`) are not a write to it.
 */
function protectedWriteRefusal(paths: readonly string[]): Refusal {
  const home = homedir();
  const names = paths.flatMap((path) => path.startsWith(`${home}/`)
    ? [escape(path), escape(`~${path.slice(home.length)}`), escape(`$HOME${path.slice(home.length)}`)] : [escape(path)]);
  const named = names.length === 0 ? "(?!)" : `(?:${names.join("|")})(?![\\w.-])`;
  // A verb counts only at the head of a command, so `grep install ~/.local/bin/gh` is a read. `cp`, `mv`, `install` and `ln` write their LAST argument, so
  // a protected path as their source is a read; the others change or remove the file wherever it sits.
  const head = String.raw`(?:^|[;&|(\n]|\$\()\s*(?:sudo\s+)?`;
  const lastArgument = String.raw`\s*(?=[;&|)\n]|$)`;
  const alternatives = [
    String.raw`${head}(?:cp|mv|install|ln)\b[^\n;&|]*\s${named}${lastArgument}`,
    String.raw`${head}(?:rm|chmod|truncate|tee)\b[^\n;&|]*${named}`,
    String.raw`${head}sed\s+-i\b[^\n;&|]*${named}`,
    String.raw`\bdd\b[^\n;&|]*\bof=${named}`,
    String.raw`>>?\s*${named}`,
  ];
  return { pattern: new RegExp(alternatives.join("|")),
    why: `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} the host's ${paths.length === 1 ? "program" : "programs"}, which a worker may not write` };
}

/** The file a write tool names, resolved as the disk resolves it: `~` expanded and the directory's symbolic links followed, so a link into the bin directory is that file. */
export function resolveWritePath(path: string, real: (path: string) => string = realpathSync): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  const full = resolve(expanded);
  try {
    return join(real(dirname(full)), basename(full));
  } catch {
    return full;
  }
}

const SKILL_REFUSALS: readonly Refusal[] = [
  { pattern: /post-pr-to-slack/, why: "announcing a pull request is the person's" },
];

/**
 * The PreToolUse verdict for one tool call. `machine` holds this machine's own Bash refusals, after the built-in ones, and `connectors` the
 * connector tool names it allows. `approved` names the pull requests a review run may mark ready, by URL: none for any other run. `publish`
 * holds the connector tool names a publish run may call as well, and is null for any other run, which may not announce a pull request. `ready` is
 * true for a run on a machine with `tickets.drafts: false`, which may open its pull request ready rather than as a draft. PURE.
 */
export function toolVerdict(toolName: string, input: Record<string, unknown>, options: {
  /** This machine's own Bash refusals, after the built-in ones. */
  machine?: readonly Refusal[];
  /** The connector tool names this machine allows. */
  connectors?: readonly RegExp[];
  /** The pull requests a review run may mark ready, by URL. */
  approved?: readonly string[];
  /** The connector tool names a publish run may call, or null for a run that is no publish run. */
  publish?: readonly RegExp[] | null;
  /** A run on a machine with `tickets.drafts: false` may open its pull request ready. */
  ready?: boolean;
  /** The host's own programs a worker may not write, by path. */
  hostPrograms?: readonly string[];
} = {}): HookResult {
  const { machine = [], connectors = [], approved = [], publish = null, ready = false, hostPrograms = [] } = options;
  if (toolName.startsWith("mcp__")) {
    const allowed = [...connectors, ...(publish ?? [])];
    return allowed.some((pattern) => pattern.test(toolName)) ? ALLOW : refuse(`${toolName} is a connector this machine's tickets.connectors does not allow`);
  }
  if (toolName === "Skill") {
    const skill = String(input.skill ?? input.name ?? "");
    const hit = publish === null ? SKILL_REFUSALS.find(({ pattern }) => pattern.test(skill)) : undefined;
    return hit ? refuse(`the ${skill} skill is refused: ${hit.why}`) : ALLOW;
  }
  if (FILE_TOOLS.has(toolName)) {
    const file = String(input.file_path ?? input.notebook_path ?? "");
    if (MARK_REFUSAL.pattern.test(file)) return refuse(MARK_REFUSAL.why);
    return hostPrograms.includes(file) ? refuse(`${file} is the host's program, which a worker may not write`) : ALLOW;
  }
  if (toolName !== "Bash") return ALLOW;
  const command = String(input.command ?? "");
  if (/\bgh\s+pr\s+create\b/.test(command) && !/--draft\b/.test(command) && !ready) return refuse("open the pull request as a draft: `gh pr create --draft`");
  const hit = [...BASH_REFUSALS, HOST_INSTALL_REFUSAL, protectedWriteRefusal(hostPrograms), readyRefusal(approved), MARK_REFUSAL, ...machine]
    .find(({ pattern }) => pattern.test(command));
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

/** The host's own programs a worker may not write, from the pool's copy beside the outcome file. None when there is no copy, or none it can read. */
export function protectedFiles(ticketDir: string): { paths: string[]; note?: string } {
  const file = join(ticketDir, PROTECTED_FILE);
  // A copy the pool did not write, or one it cannot read, must not leave the host's programs open: the two programs in the default bin directory are protected
  // all the same, and the note says so. Resolved as a write tool's path is (`resolveWritePath`), so a link to the bin directory names the same files.
  const fallback = protectedPaths(defaultBinDir(homedir()));
  const named = (paths: string[]) => ({ paths: paths.map((path) => resolveWritePath(path)) });
  try {
    const paths = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) return named(paths);
    return { ...named(fallback), note: `ticket:hook: ${file} is not a list of paths, so the default bin directory's programs are protected.` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ...named(fallback), note: `ticket:hook: ${file} is missing, so the default bin directory's programs are protected.` };
    return { ...named(fallback), note: `ticket:hook: could not read ${file}, so the default bin directory's programs are protected.` };
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

/** Whether an outcome file's text is a `working` outcome. Text that is not JSON is not one: the pool reads it as it reads any outcome. PURE. */
function isWorking(text: string): boolean {
  try {
    return (JSON.parse(text) as { kind?: unknown } | null)?.kind === "working";
  } catch {
    return false;
  }
}

/**
 * The background work the session's transcript shows as live: its count, or the reason it could not be read (the Stop payload named no transcript,
 * or the file is not there or not readable). A transcript that cannot be read is not a refusal: the caller allows the stop out loud.
 */
function liveWork(transcriptPath: string | undefined, read: (path: string) => string): { live: number; unreadable?: string } {
  if (transcriptPath === undefined) return { live: 0, unreadable: "the Stop payload names no transcript_path" };
  try {
    const work = liveBackgroundWork(read(transcriptPath));
    return { live: work.shells.length + work.monitors.length };
  } catch (err) {
    return { live: 0, unreadable: `${transcriptPath}: ${String((err as Error)?.message ?? err).split("\n")[0]}` };
  }
}

/**
 * The Stop verdict: allowed once the outcome file is there, refused with its path otherwise, up to {@link MAX_STOP_REFUSALS} in a row. A `working`
 * outcome allows one stop, and only while the session has live background work to wake it (`transcriptPath`); a later stop on the same file, by its
 * time, is refused the same way, so a worker its background work woke says how the run stands now.
 */
export function stopVerdict(ticketDir: string, { exists = existsSync, read = (p: string) => readFileSync(p, "utf8"), write = (p: string, t: string) => writeFileSync(p, t),
  mtime = (p: string) => statSync(p).mtimeMs, transcriptPath }: {
  exists?: (path: string) => boolean; read?: (path: string) => string; write?: (path: string, text: string) => void; mtime?: (path: string) => number;
  transcriptPath?: string;
} = {}): HookResult {
  const outcome = join(ticketDir, OUTCOME_FILE);
  const counter = join(ticketDir, STOP_COUNT_FILE);
  const stamp = join(ticketDir, WORKING_STOP_FILE);
  let ask = `write ${outcome} before you stop, with one of the outcomes your brief lists, such as { "kind": "needs-human", "reason": "..." }.`;
  if (exists(outcome)) {
    const working = isWorking(read(outcome)) ? String(mtime(outcome)) : null;
    if (working === null) {
      write(counter, "0");
      return ALLOW;
    }
    if (!exists(stamp) || read(stamp).trim() !== working) {
      const work = liveWork(transcriptPath, read);
      if (work.unreadable === undefined && work.live === 0) {
        ask = `${NOTHING_WAKES}. ${outcome} says working, but none of your background work is running: wait for the work in the foreground, or write the outcome the run ended on.`;
      } else {
        // Let through, with its time stamped, so a stop on this same file is refused once its work has woken the worker.
        write(stamp, working);
        write(counter, "0");
        return work.unreadable === undefined ? ALLOW : { code: 0, say: [`ticket:hook: could not read the transcript (${work.unreadable}), so working is ALLOWED.`] };
      }
    } else {
      ask = `${outcome} still says working from before your background work woke you: write it again with how the run stands now, or with { "kind": "working", "reason": "..." } again if more of your own work is still running.`;
    }
  }
  const refused = exists(counter) ? Number.parseInt(read(counter), 10) || 0 : 0;
  if (refused >= MAX_STOP_REFUSALS) {
    const what = exists(outcome) ? `on the same working outcome in ${outcome}, so this one is allowed and the board keeps the run in progress` : `without ${outcome}, so this one is allowed and the board records no outcome`;
    return { code: 0, say: [`ticket-mode: ${refused} stops in a row ${what}.`] };
  }
  write(counter, String(refused + 1));
  return refuse(ask);
}

/** The transcript a Stop payload names, where Claude Code writes the session, or undefined when the payload names none it can read. */
function transcriptOf(stdin: string): string | undefined {
  try {
    const path = (JSON.parse(stdin) as { transcript_path?: unknown } | null)?.transcript_path;
    return typeof path === "string" && path !== "" ? path : undefined;
  } catch {
    return undefined;
  }
}

export function main(stdin: string, argv: string[]): HookResult {
  const [event, ticketDir] = argv;
  if ((event !== "stop" && event !== "pre-tool-use") || !ticketDir) return { code: 0, say: [`ticket:hook: usage is ticket:hook stop|pre-tool-use <ticket dir>, so this call is ALLOWED.`] };
  try {
    if (event === "stop") return stopVerdict(ticketDir, { transcriptPath: transcriptOf(stdin) });
    const payload = JSON.parse(stdin) as { tool_name?: string; tool_input?: Record<string, unknown> };
    const { refusals, note } = machineRefusals(ticketDir);
    const allowed = machineConnectors(ticketDir);
    const input = payload.tool_input ?? {};
    const guarded = protectedFiles(ticketDir);
    const verdict = toolVerdict(String(payload.tool_name ?? ""), typeof input.file_path === "string" ? { ...input, file_path: resolveWritePath(input.file_path) } : input, {
      machine: refusals, connectors: allowed.connectors, approved: approvedPulls(ticketDir), publish: publishConnectors(ticketDir),
      ready: existsSync(join(ticketDir, READY_FILE)), hostPrograms: guarded.paths,
    });
    const notes = [note, allowed.note, guarded.note].filter((n): n is string => n !== undefined);
    return notes.length === 0 ? verdict : { ...verdict, say: [...notes, ...verdict.say] };
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
