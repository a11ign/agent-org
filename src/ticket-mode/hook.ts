#!/usr/bin/env node
// @ts-check
// command: ticket:hook -- the Stop and PreToolUse hook every ticket-mode worker runs under: `ticket:hook stop|pre-tool-use <ticket dir>`
//
// STOP: A RUN ENDS ON AN OUTCOME FILE. A worker that stops without writing one leaves the board with nothing to show, so the stop is refused with
// the file's path, at most twice in a row, after which it is allowed and the pool records `no-outcome`. It does NOT honour `stop_hook_active`, as
// `worker-stop-hook.ts` does: the nbl-ui plugin's own Stop gates block once and then let the next stop through on that flag, and a hook that also
// honoured it would let a worker end on that second stop with no outcome. Its own count is what bounds it.
//
// A GRILL RUN WAITS, IT DOES NOT FAIL (A11-129). A grill new-ticket run ends its turn with no outcome to ask the person a question. That stop is let
// through, and the hook records the question beside the outcome file (`waiting.json`: the Stop payload's last message, else the transcript's last
// assistant text), so the board shows it. Nothing depends on the agent writing a file to say so.
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
// person's is lifted. A PUBLISH RUN, which a person started by pressing Publish, may run the publisher plugin's skill (its manifest's `tooling.skills`) and call the
// connectors the host file's `tickets.providers.publish.connectors` names: the pool leaves `publish-run` beside its outcome file naming them, which no worker may
// write either, and merging, reviewing, force-pushing and running a workflow stay refused.
//
// THE HOST'S OWN PROGRAMS (A11-84): a worker may not write the routing `gh` or the launcher `agent-org` in the host's bin directory, which the pool names in
// `protected-paths.json` beside the outcome file, and may not run `host:install` or any other command that installs them. The hook cannot see a TEST that writes
// the file, so this is defence in depth: the guarded writer (`writeGhWrapper`) is what keeps a test from writing it.
//
// On a machine with `tickets.drafts: false` the pool leaves `ready-run` beside the outcome file, and a worker may open its pull request ready
// (`gh pr create` without `--draft`) only then. Without that mark, the draft refusal applies to every run, as before. No worker may write the mark.
//
// A PRE-PR REVIEW GATE (A11-86). On a machine whose `tickets.prReview` names a skill, a push or a pull request is refused until that skill has run
// since the worker's last commit. The hook keeps that order in an append-only log beside the outcome file, `pr-review-log`: a `review` line for each
// call of the skill and a `commit` line for each git commit that makes one. The gate allows a push or a pull request only when the log's last line
// is `review`. Absent the setting, nothing is logged and nothing is refused on a review. Once the setting's copy is there, the gate fails CLOSED: a copy
// it cannot read, or a log it cannot read or write, refuses the pushes and pull requests it holds, since it could not check them.
//
// A STOP MUST BE ON THE ESCALATION LIST (A11-257). Only the items of `escalation.ts` reach a person, so a `needs-human` outcome that names no item of the list in `escalation`, and a `planned` one that leaves a `QUESTION.md` whose
// first line is not `**Escalation:** <id>`, are refused with the list and the order to decide it and record it under "Decisions made without a person". The refusal is counted and bounded like every other (`MAX_STOP_REFUSALS`), so an agent
// is never held for ever, and the board marks a stop that gets through "Off the escalation list:" (`pool-outcome.ts`, `pool-settle.ts`). A Talk session, a new-ticket run and a publish run are exempt: a person is in the first, and the
// others' `needs-human` reports a failure. The board leaves a mark beside the outcome file for each.
//
// IT FAILS OPEN, OUT LOUD, for a payload or a count it cannot read: a hook that refused on what it could not read would stop every worker.
//
// A NEW-TICKET RUN FILES ITS OWN TICKET (A11-135). The board grants it, in its mark, the tracker's create tool and the two attachment tools, and no other
// filing tool. A creation is refused when it names an `id` (an update) or `blocks` (a relation on another ticket), and past ten in the run. An attachment is
// refused unless it names a ticket the run created, which the POST-TOOL-USE hook records as each creation returns (`created-issues.jsonl`, which only the
// hook writes). A build worker is refused every filing tool by name, before the connector allow list is read, and the refusal names New ticket.
import { appendFileSync, closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { escapeRegExp } from "../lib/escape-regexp.ts";
import { escalationItem, offListRefusal, questionEscalation } from "./escalation.ts";
import type { TrackerWriting } from "../plugins/contracts/tracker.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { lastAssistantText, liveBackgroundWork } from "./background-work.ts";
import { findingsMiss, parseFindingsGiven, retryAsk } from "./blocker-findings-check.ts";
import { type Order, parseOrder } from "./batch-order.ts";
import { boardKeyPath } from "./board-key.ts";
import type { Wait } from "./wait-on/wait-types.ts";
import { checkOutcome, isStale } from "./outcome.ts";
import { CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, claimsRetryAsk, folderClaimMisses, parseClaimsGiven, planClaimPaths, siblingClaims } from "./path-claims.ts";
import { PLAN_FILE_BYTES } from "./pool-outcome.ts";
import type { DenyRule } from "./settings.ts";
import { ASKED_FILE, CONNECTORS_FILE, DENY_FILE, FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE, OUTCOME_FILE, PROTECTED_FILE, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, PUBLISH_FILE, READY_FILE, REVIEW_FILE,
  ORDER_FILE, QUESTION_FILE, STALE_OUTCOME_FILE, STOP_ACTIVE_FILE, STOP_COUNT_FILE, TALK_FILE, WAITING_FILE, WORKING_STOP_FILE, WRITER_FILE, defaultBinDir, protectedPaths } from "./worker-files.ts";
import { CREATED_FILE, MAX_CREATED, createdKeyOf, createdLine, parseWriterOutcome, readCreatedKeys } from "./writer.ts";

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


/**
 * Marking a pull request ready is the person's, until they approve it on the board: then a review run may mark the pull requests they
 * approved, each named by its URL, and never undo one.
 */
function readyRefusal(approved: readonly string[]): Refusal {
  const named = approved.length === 0 ? "" : `(?![^\\n;&|]*(?:${approved.map(escapeRegExp).join("|")})(?![\\w/]))`;
  return { pattern: new RegExp(`\\bgh\\s+pr\\s+ready\\b${named}|\\bgh\\s+pr\\s+ready\\b[^\\n;&|]*--undo\\b`),
    why: "marking a pull request ready is the person's, except a review run's own approved pull requests, by URL" };
}

/**
 * The review, publish, writer and ready marks are the board's: a worker that wrote one would lift a refusal. So are a grill run's question and its moved
 * outcome: a worker that wrote them would answer its own question (A11-129). The record of a new-ticket run's created tickets is the hook's own, so
 * a run could not write in a key it did not create (A11-135). The stale mark and the stop hook's own file are the board's too (A11-152): a worker that
 * wrote the first could refuse its own outcome, and one that wrote the second could hold the board off its question. A planning run's list of the pull requests its plan must name and the mark of
 * its one automatic retry are the board's (A11-207): a planner that wrote the first could lift its own check, and one that wrote the second could skip the retry. The same goes for the list of paths other
 * tickets hold and the mark of the retry made for a folder claim (A11-212).
 */
const BOARD_FILES: readonly string[] = [REVIEW_FILE, PUBLISH_FILE, WRITER_FILE, READY_FILE, WAITING_FILE, ASKED_FILE, CREATED_FILE, STALE_OUTCOME_FILE, STOP_ACTIVE_FILE, FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE, CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, TALK_FILE];
const MARK_REFUSAL: Refusal = { pattern: new RegExp(`\\b(?:${BOARD_FILES.map(escapeRegExp).join("|")})\\b`),
  why: `${BOARD_FILES.join(", ")} are the board's to write` };

/**
 * The board's key and its queue actions are a person's (A11-250). The server's one boundary is the key, and a run is the same Unix user as the file that holds it: a run that read the key could call the answer route
 * and write a decision into its own ticket, which only a person's answer may do. So no run names the key's file in a command or opens it with a file tool, and none names a queue action route (`/api/queue/<key>/<verb>`).
 */
const KEY_FILE = basename(boardKeyPath(""));
const BOARD_KEY_REFUSAL: Refusal = { pattern: new RegExp(`(?<![\\w.-])${escapeRegExp(KEY_FILE)}(?![\\w.-])`),
  why: `the board's key (${KEY_FILE}) is the person's: a run may not name it, and the board's API answers only to it` };
const BOARD_ROUTE_REFUSAL: Refusal = { pattern: /\/api\/queue\/[^\s/'"]+\/[a-z-]+/,
  why: "the board's queue actions are the person's, and the answer route alone writes a ticket's Decisions" };
/** The tools that open a file by its path, and the input that names it: a run may not open the board's key with any of them. */
const KEY_READERS: Readonly<Record<string, string>> = { Read: "file_path", Grep: "path", Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
/** Whether `path` is the board's key file. PURE. */
const namesKeyFile = (path: string): boolean => basename(path) === KEY_FILE;

/**
 * The connector tools a new-ticket run may call: the reads only, by name (`get`, `list`, `search`, `extract`, `read`, `find`, `fetch`). A run that
 * writes the tracker would make a ticket the person has not approved, so the name is the check, whatever `tickets.connectors` allows. PURE.
 */
const READ_ONLY_CONNECTOR = /^mcp__[\w-]+__(get|list|search|extract|read|find|fetch)_/;
/**
 * The pre-PR review's files, the hook's log and the pool's copy of the setting. Only the gate refuses them, and only when the setting is named, so a machine
 * without it is unchanged (A11-86).
 */
const PR_REVIEW_FILE_REFUSAL: Refusal = { pattern: new RegExp(`\\b(?:${[PR_REVIEW_FILE, PR_REVIEW_LOG_FILE].map(escapeRegExp).join("|")})\\b`),
  why: `${PR_REVIEW_FILE} and ${PR_REVIEW_LOG_FILE} are the pool's and the hook's: a worker may not write them, nor name them in a command` };
/**
 * What each tracker plugin of the registry declares a new-ticket run files with (`TrackerWriting`, tracker contract 1.1): read from the plugins' manifests and not from their
 * code, because this hook is a process started for every tool call and must not import a plugin to answer one. Every plugin's, not the enabled one's: a tool that files a ticket in
 * any known tracker is refused to a build worker, whichever tracker the host runs.
 */
export const trackerWritings = (catalog = defaultCatalog()): readonly TrackerWriting[] => catalog.plugins.flatMap(({ concern, tooling }) => (concern === "tracker" && tooling.writer !== undefined ? [tooling.writer] : []));

/** The tools a new-ticket run may be granted: each tracker's create tool and attach tools. */
const grantable = (writings: readonly TrackerWriting[]): string[] => writings.flatMap(({ createTool, attachTools }) => [createTool, ...attachTools]);

// The tracker tools that file a ticket or attach to one, on any server of a tracker (`filingTools`), are a new-ticket run's alone, and only the ones the board granted
// it (A11-135): a build worker is refused each by name, whatever `tickets.connectors` allows.
const filingRefusal = (label: string): string => `workers file no tickets (${label} is read and comment only for them); to file one, use New ticket on the board`;
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
    ? [escapeRegExp(path), escapeRegExp(`~${path.slice(home.length)}`), escapeRegExp(`$HOME${path.slice(home.length)}`)] : [escapeRegExp(path)]);
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

/**
 * The Claude Code skills the catalog's PUBLISHER plugins declare (`tooling.skills`), read as data: the hook is a process started for every tool call, and must not import a plugin to answer one.
 * Announcing a pull request is the person's, so no run but a publish run (the one a person's Publish started) may run one of them, whichever publisher is enabled or whether any is (A11-161).
 */
export const publisherSkills = (catalog = defaultCatalog()): readonly string[] => catalog.plugins.flatMap(({ concern, tooling }) => (concern === "publisher" ? tooling.skills : []));

/**
 * A filing call from a new-ticket run (A11-135): only a tool the board granted, and only the creation the run needs. A creation is `save_issue` with no
 * `id`, and no `blocks`, which writes on another ticket. An attachment names a ticket this run created. A run's record it cannot read refuses the call,
 * since the check could not be made. PURE.
 */
function writerFiling(toolName: string, input: Record<string, unknown>, run: Readonly<{ grants: readonly string[]; created: readonly string[] | null; writings: readonly TrackerWriting[] }>): HookResult {
  const { grants, created, writings } = run;
  const writing = writings.find(({ createTool, attachTools }) => createTool === toolName || attachTools.includes(toolName));
  if (!grants.includes(toolName) || writing === undefined) return refuse(`${toolName} is not a tool the board granted this new-ticket run: it files one ticket and attaches its plan, and nothing else`);
  if (created === null) return refuse(`${CREATED_FILE} cannot be read, so ${toolName} cannot be checked against the tickets this run created`);
  if (toolName === writing.createTool) {
    const refused = writing.refusedInputs.find(({ input: name }) => name in input);
    if (refused !== undefined) return refuse(`${toolName} ${refused.refusal}`);
    if (created.length >= MAX_CREATED) return refuse(`this run has already created ${MAX_CREATED} tickets, the most a new-ticket run may create`);
    return ALLOW;
  }
  const issue = String(input[writing.attachTicketInput] ?? "");
  return created.includes(issue) ? ALLOW : refuse(`${toolName} names ${issue || "no ticket"}, which this run did not create: a new-ticket run attaches only to a ticket it created`);
}

/** The filing tools the board granted a new-ticket run, from its mark beside the outcome file: none where the mark names none or cannot be read. PURE over `read`. */
export function writerGrants(ticketDir: string, read: (path: string) => string = (p) => readFileSync(p, "utf8"), writings?: readonly TrackerWriting[]): string[] {
  try {
    const { tools } = JSON.parse(read(join(ticketDir, WRITER_FILE))) as { tools?: unknown };
    // The registry is read only for a run with a mark that names tools: every other tool call of every other run costs the hook nothing of it.
    const granted = Array.isArray(tools) && tools.length > 0 ? grantable(writings ?? trackerWritings()) : [];
    return Array.isArray(tools) ? tools.filter((tool): tool is string => granted.includes(tool as string)) : [];
  } catch {
    return [];
  }
}

/**
 * The PostToolUse verdict for a creation a new-ticket run made (A11-135). The key the tracker answered with is appended to the record beside the outcome
 * file, which the board checks the outcome's keys against and the PreToolUse hook counts. A result with no key, or a record that cannot be written, is
 * refused out loud, so the agent sees that a ticket it made is not recorded. A call that is not a creation by a new-ticket run is ignored.
 */
export function recordCreated(ticketDir: string, toolName: string, response: unknown, writings: readonly TrackerWriting[] = trackerWritings()): HookResult {
  const writing = writings.find(({ createTool }) => createTool === toolName);
  if (writing === undefined || !existsSync(join(ticketDir, WRITER_FILE))) return ALLOW;
  const key = createdKeyOf(response, writing.createdKey);
  if (key === null) {
    return refuse(`the ticket was created, but its key is not in the result, so it is not recorded and the board cannot show it: look it up in the tracker, and do not create it again`);
  }
  try {
    appendFileSync(join(ticketDir, CREATED_FILE), createdLine(key));
  } catch (err) {
    return refuse(`${key} was created, but ${CREATED_FILE} cannot be written (${firstLine(err)}), so the board cannot show it`);
  }
  return ALLOW;
}

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
  /** A new-ticket run: it may call only the allowed connectors that only read the tracker, and the filing tools the board granted it. */
  writer?: boolean;
  /** The filing tools the board granted a new-ticket run, by name. */
  grants?: readonly string[];
  /** What the tracker plugins declare a new-ticket run files with: every tracker plugin of the registry's catalog when absent. */
  trackers?: readonly TrackerWriting[];
  /** The keys the run has created so far, from its record; null when the record cannot be read. */
  created?: readonly string[] | null;
  /** The pull requests a review run may mark ready, by URL. */
  approved?: readonly string[];
  /** The connector tool names a publish run may call, or null for a run that is no publish run. */
  publish?: readonly RegExp[] | null;
  /** The skills only a publish run may run: every publisher plugin of the registry's catalog declares them when absent. */
  publisherSkills?: readonly string[];
  /** A run on a machine with `tickets.drafts: false` may open its pull request ready. */
  ready?: boolean;
  /** The host's own programs a worker may not write, by path. */
  hostPrograms?: readonly string[];
} = {}): HookResult {
  const { machine = [], connectors = [], approved = [], publish = null, ready = false, hostPrograms = [], writer = false, grants = [], created = [] } = options;
  if (toolName.startsWith("mcp__")) {
    const writings = options.trackers ?? trackerWritings();
    const filed = writings.find(({ filingTools }) => new RegExp(filingTools).test(toolName));
    if (filed !== undefined) return writer ? writerFiling(toolName, input, { grants, created, writings }) : refuse(filingRefusal(filed.label));
    if (writer) {
      return connectors.some((pattern) => pattern.test(toolName)) && READ_ONLY_CONNECTOR.test(toolName) ? ALLOW
        : refuse(`${toolName} may not be called by a new-ticket run: it reads the tracker, and creates nothing but the ticket it files and that ticket's plan`);
    }
    const allowed = [...connectors, ...(publish ?? [])];
    return allowed.some((pattern) => pattern.test(toolName)) ? ALLOW : refuse(`${toolName} is a connector this machine's tickets.connectors does not allow`);
  }
  if (toolName === "Skill") {
    const skill = String(input.skill ?? input.name ?? "");
    const refused = publish === null && (options.publisherSkills ?? publisherSkills()).some((name) => skill.includes(name));
    return refused ? refuse(`the ${skill} skill is refused: announcing a pull request is the person's`) : ALLOW;
  }
  const keyed = KEY_READERS[toolName];
  if (keyed !== undefined && namesKeyFile(String(input[keyed] ?? ""))) return refuse(BOARD_KEY_REFUSAL.why);
  if (FILE_TOOLS.has(toolName)) {
    const file = String(input.file_path ?? input.notebook_path ?? "");
    if (MARK_REFUSAL.pattern.test(file)) return refuse(MARK_REFUSAL.why);
    return hostPrograms.includes(file) ? refuse(`${file} is the host's program, which a worker may not write`) : ALLOW;
  }
  if (toolName !== "Bash") return ALLOW;
  const command = String(input.command ?? "");
  if (/\bgh\s+pr\s+create\b/.test(command) && !/--draft\b/.test(command) && !ready) return refuse("open the pull request as a draft: `gh pr create --draft`");
  const hit = [...BASH_REFUSALS, HOST_INSTALL_REFUSAL, protectedWriteRefusal(hostPrograms), readyRefusal(approved), MARK_REFUSAL, BOARD_KEY_REFUSAL, BOARD_ROUTE_REFUSAL, ...machine]
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

/** Whether a Bash command opens a pull request or pushes: the commands the gate holds until the review has run. PURE. */
export function heldCommand(command: string): boolean {
  return PULL_REQUEST.test(command) || gitSubcommands(command).includes("push");
}

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
  if (!heldCommand(command)) return null;
  const commits = gitSubcommands(command).some((subcommand) => COMMIT_SUBCOMMANDS.has(subcommand));
  if (log[log.length - 1] === "review" && !commits) return null;
  const why = commits ? "this command commits, so the skill cannot have reviewed what it pushes: commit first, run the skill, then push"
    : `it has not run since your last commit`;
  return `run the \`${skill}\` skill on your whole diff before you push or open a pull request: ${why}. Fix what it finds, re-run the tests, commit, and run it again until it finds nothing.`;
}

/**
 * The pre-PR review setting from the copy of `tickets.prReview` beside the outcome file. No copy is no review: `skill` null and no `problem`. A copy
 * that names a skill is `skill`. A copy that is there but cannot be read, or names no skill, is a `problem`: the gate cannot tell what the machine asked
 * for, so the pushes and pull requests it holds are refused, and its files stay protected (A11-86).
 */
export function prReviewSetting(ticketDir: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): { skill: string | null; problem?: string } {
  const file = join(ticketDir, PR_REVIEW_FILE);
  try {
    const skill = JSON.parse(read(file)) as unknown;
    return typeof skill === "string" && skill !== "" ? { skill } : { skill: null, problem: `${file} names no skill` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { skill: null };
    return { skill: null, problem: `${file} cannot be read` };
  }
}

/**
 * The gate for a tool call the other refusals allowed, when the setting names a skill. A push or a pull request is refused unless the review has run since
 * the last commit. A call that is a review or a commit is logged, one line, so parallel calls cannot lose one. A log the gate cannot read or write refuses
 * the call that needs it, since the gate would otherwise pass on state it could not check (A11-86).
 */
function prReviewGate(toolName: string, input: Record<string, unknown>, ticketDir: string, skill: string): HookResult {
  const log = join(ticketDir, PR_REVIEW_LOG_FILE);
  const command = toolName === "Bash" ? String(input.command ?? "") : "";
  const event = prReviewEvent(toolName, input, skill);
  if (event === null && !heldCommand(command)) return ALLOW;
  let events: string[];
  try {
    events = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
  } catch (err) {
    return refuse(`${log} cannot be read (${firstLine(err)}), so the pre-PR review cannot be checked for this call`);
  }
  const refusal = prReviewRefusal(command, events, skill);
  if (refusal !== null) return refuse(refusal);
  if (event === null) return ALLOW;
  try {
    appendFileSync(log, `${event}\n`);
  } catch (err) {
    return refuse(`${log} cannot be written (${firstLine(err)}), so this ${event} cannot be recorded for the pre-PR review`);
  }
  return ALLOW;
}

const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0];

/**
 * The pre-PR review verdict for a call the other refusals allowed. Its files are protected whenever the setting's copy is there, named or not, so no
 * worker can delete a copy it cannot read and turn the gate off. A named skill runs the gate; a copy with a problem refuses the pushes and pull requests
 * it holds, since the gate cannot tell what it asked for; no copy is no gate at all.
 */
function prReviewVerdict(toolName: string, input: Record<string, unknown>, ticketDir: string, review: { skill: string | null; problem?: string }): HookResult {
  const target = toolName === "Bash" ? String(input.command ?? "") : FILE_TOOLS.has(toolName) ? String(input.file_path ?? input.notebook_path ?? "") : "";
  const present = review.skill !== null || review.problem !== undefined;
  if (present && PR_REVIEW_FILE_REFUSAL.pattern.test(target)) return refuse(PR_REVIEW_FILE_REFUSAL.why);
  if (review.skill !== null) return prReviewGate(toolName, input, ticketDir, review.skill);
  if (review.problem !== undefined && toolName === "Bash" && heldCommand(target)) {
    return refuse(`${review.problem}, so the pre-PR review cannot be checked: a push or a pull request is refused until it can be read`);
  }
  return ALLOW;
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

/** An outcome file as a stop read it: its text and its time in ms, from the one read. */
export type OutcomeRead = Readonly<{ text: string; mtime: number }>;

/**
 * Reads the outcome file once. The file is opened and both its text and its mtime come from that open descriptor, so a file the board moves aside after
 * the open is still read. Null only when there is no file at `path`: any other failure is thrown, and the stop is allowed out loud (A11-152).
 */
export function readOutcomeFile(path: string): OutcomeRead | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const text = readFileSync(fd, "utf8");
    return { text, mtime: fstatSync(fd).mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** The filesystem a stop reads and writes, passed as one value so the helpers below take at most two arguments. */
type StopIo = Readonly<{
  exists: (path: string) => boolean; read: (path: string) => string; write: (path: string, text: string) => void;
  /** The names of the plan files in a plan folder, as the board takes them. */
  planNames: (planDir: string) => string[];
}>;

/** The outcome file a stop is judged on, the stamp a `working` one leaves beside it, the transcript that may wake it, and whether the run is a new-ticket run, whose outcomes are the writer's (A11-267). */
type StopSubject = Readonly<{ outcome: string; stamp: string; transcriptPath: string | undefined; writer: boolean }>;

/** A stop's judgment: allowed (`verdict`), or refused with what to ask (`ask`) and the words the count limit uses for it (`stuck`). */
type Judgment = Readonly<{ verdict: HookResult } | { ask: string; stuck: string }>;

/**
 * A `working` outcome: allowed once its stamp is written, while live background work will wake the worker (A11-80, A11-85), or while the outcome declares the events it waits on, which the board polls and prompts the
 * worker for (A11-245): such a worker has no shell of its own running, and ends its turn to be woken. Refused otherwise. A second stop on the same file is refused either way, once the work or the board has woken the worker.
 */
function judgeWorking({ outcome, stamp, transcriptPath }: StopSubject, mtime: number, io: StopIo, waits?: readonly Wait[]): Judgment {
  const declared = waits !== undefined;
  const working = String(mtime);
  const stuck = `on the same working outcome in ${outcome}, so this one is allowed and the board keeps the run in progress`;
  if (io.exists(stamp) && io.read(stamp).trim() === working) {
    const woken = declared ? "the board woke you for the wait it declares" : "your background work woke you";
    return { ask: `${outcome} still says working from before ${woken}: write it again with how the run stands now, or with { "kind": "working", "reason": "..." } again if more of it is still running.`, stuck };
  }
  const work = declared ? null : liveWork(transcriptPath, io.read);
  if (work !== null && work.unreadable === undefined && work.live === 0) {
    return { ask: `${NOTHING_WAKES}. ${outcome} says working, but none of your background work is running: wait for the work in the foreground, declare what you wait on in waitingOn (a fleet job, a CI run, a pull request or a ticket), or write the outcome the run ended on.`, stuck };
  }
  // Let through, with its time stamped, so a stop on this same file is refused once its work has woken the worker.
  io.write(stamp, working);
  return { verdict: work === null || work.unreadable === undefined ? ALLOW : { code: 0, say: [`ticket:hook: could not read the transcript (${work.unreadable}), so working is ALLOWED.`] } };
}

/** The judgment of the outcome file as it stands: refused when the contract refuses it, allowed unless it says `working`, and `working` judged on its own. */
function judgeOutcome(subject: StopSubject, { text, mtime }: OutcomeRead, io: StopIo): Judgment {
  if (subject.writer) return judgeWriterOutcome(subject.outcome, text);
  const checked = checkOutcome(text);
  if ("problem" in checked) {
    // The field the contract wants is named, so the worker fixes the file in the same turn; a near miss is refused here too (A11-118).
    const stuck = checked.ok
      ? `on the same outcome in ${subject.outcome}, which names one pull request in pr, so this one is allowed and the board records that pull request`
      : `on the same invalid outcome in ${subject.outcome}, so this one is allowed and the board hands the run back for a person`;
    return { ask: `${checked.problem}. Write ${subject.outcome} again as the last thing you do, in the shape your brief shows.`, stuck };
  }
  return checked.outcome.kind === "working" ? judgeWorking(subject, mtime, io, checked.outcome.waits) : { verdict: ALLOW };
}

/**
 * The judgment of a new-ticket run's outcome file (A11-267): the writer's own contract, `parseWriterOutcome`, which is the one the board reads it with (`pool-board-runs.ts`). The kinds a ticket worker ends on are not the writer's:
 * a writer ends on `created`, `decided` or `needs-human`, so `created` is allowed here and refused for a worker, and a writer's `working` is refused, since nothing in its brief lets it wait.
 */
function judgeWriterOutcome(outcome: string, text: string): Judgment {
  const parsed = parseWriterOutcome(text);
  const stuck = `on the same invalid outcome in ${outcome}, so this one is allowed and the board fails the run`;
  if (typeof parsed === "string") return { ask: `${outcome}: ${parsed}. Write ${outcome} again as the last thing you do, in the shape your brief shows.`, stuck };
  return { verdict: ALLOW };
}

/**
 * Whether the run's stops are exempt from the escalation list (A11-257): a Talk session, which has a person in its terminal, a new-ticket run, whose grill waits for a person and whose `needs-human` reports a failure, and a
 * publish run, whose `needs-human` reports a failure too. The board leaves a mark for each beside the outcome file.
 */
const exemptFromEscalation = (ticketDir: string, io: StopIo): boolean => [TALK_FILE, WRITER_FILE, PUBLISH_FILE].some((file) => io.exists(join(ticketDir, file)));

/** The `QUESTION.md` files that name no item of the list, as the ticket's key and the file's path; or `unread`, why the run's list of plan folders could not be read, which is not "no question". */
type OffListQuestions = Readonly<{ found: readonly { key: string; path: string }[] } | { unread: string }>;

/**
 * The `QUESTION.md` files of a planning run's plan folders (the list its brief wrote lists them) that name no item of the escalation list. A run with no such list has none to check. A list that is there and cannot be read is
 * `unread` and never an empty answer: the stop is then allowed out loud, as the other plan checks allow it, and the board's own check of a `QUESTION.md` marks one that names no item (`pool-settle.ts`).
 */
function offListQuestions(ticketDir: string, io: StopIo): OffListQuestions {
  const given = join(ticketDir, FINDINGS_GIVEN_FILE);
  if (!io.exists(given)) return { found: [] };
  try {
    const rows = parseFindingsGiven(io.read(given));
    if (rows === null) return { unread: `${given} is not a list of tickets` };
    return { found: rows.flatMap(({ key, planDir }) => {
      const path = join(planDir, QUESTION_FILE);
      return io.exists(path) && escalationItem(questionEscalation(io.read(path))) === undefined ? [{ key, path }] : [];
    }) };
  } catch (err) {
    return { unread: `${given} cannot be read (${firstLine(err)})` };
  }
}

/**
 * The refusal of a stop that is not on the escalation list (A11-257): a `needs-human` outcome that names no item of the list, or a `planned` one that leaves a `QUESTION.md` naming none. It is a {@link Judgment}, so it
 * is counted and bounded like every other refusal: past {@link MAX_STOP_REFUSALS} the stop is allowed, and the board marks it "Off the escalation list:" so that it is seen and counted. Null for a stop that stands, a run that is exempt,
 * and an outcome the contract refuses (the next judgment names that).
 */
function offListStop(ticketDir: string, { text }: OutcomeRead, io: StopIo): Judgment | null {
  if (exemptFromEscalation(ticketDir, io)) return null;
  const checked = checkOutcome(text);
  if ("problem" in checked) return null;
  const { outcome } = checked;
  if (outcome.kind === "needs-human") return escalationItem(outcome.escalation) === undefined ? offListOutcome(join(ticketDir, OUTCOME_FILE), outcome.escalation) : null;
  return outcome.kind === "planned" ? offListQuestion(offListQuestions(ticketDir, io)) : null;
}

/** The judgment of a `needs-human` outcome in `file` that names no item of the list (`named` is what it wrote in `escalation`, if anything). */
function offListOutcome(file: string, named: string | undefined): Judgment {
  const wrote = named === undefined ? "names no item" : `names "${named}", which is not an item`;
  return { ask: offListRefusal(`${file} is a needs-human outcome that ${wrote} of the escalation list`), stuck: `on a needs-human outcome in ${file} that is not on the escalation list, so this one is allowed and the board marks it "Off the escalation list"` };
}

/** The judgment of the planner's `QUESTION.md` files that name no item of the list, or null when there are none. An unreadable list of plan folders allows the stop out loud. */
function offListQuestion(checked: OffListQuestions): Judgment | null {
  if ("unread" in checked) return { verdict: { code: 0, say: [`ticket:hook: ${checked.unread}, so the plan's QUESTION.md files were not checked against the escalation list and the stop is ALLOWED; the board marks one that names no item.`] } };
  const questions = checked.found;
  if (questions.length === 0) return null;
  const listed = questions.map(({ key, path }) => `${key}: ${path}`).join("; ");
  return { ask: offListRefusal(`${listed} is a question whose first line is not \`**Escalation:** <id>\` with the id of an item of the escalation list`), stuck: `on a QUESTION.md that is not on the escalation list (${listed}), so this one is allowed and the board marks it "Off the escalation list"` };
}

/**
 * The outcome a stop judges: the file as it was read, unless the board marked it stale when a parked run resumed. An outcome written at or before the
 * mark is the one the run parked on, so it is no outcome (A11-152). A mark that is not a number makes every outcome stale: the refusal is bounded by the
 * count, so a worker is never held longer than a missing outcome holds it.
 */
function currentOutcome(ticketDir: string, found: OutcomeRead | null, io: StopIo): OutcomeRead | null {
  const mark = join(ticketDir, STALE_OUTCOME_FILE);
  if (found === null || !io.exists(mark)) return found;
  return isStale(found.mtime, io.read(mark)) ? null : found;
}

/**
 * Whether a new-ticket run is grill: its mark names the mode, and the person answers its questions in its terminal, so it may end a turn with no
 * outcome while it waits (A11-124). A mark that is not that mode's, or not read, is not grill.
 */
function interactiveWriter(ticketDir: string, io: StopIo): boolean {
  const mark = join(ticketDir, WRITER_FILE);
  if (!io.exists(mark)) return false;
  try {
    return (JSON.parse(io.read(mark)) as { mode?: unknown }).mode === "grill";
  } catch {
    return false;
  }
}

/**
 * The question a grill run asked before it ended its turn: the Stop payload's last message when it carries one, else the transcript's last assistant
 * text, else "". A transcript that cannot be read gives "", and the board shows its fixed line for a wait with no question (A11-129).
 */
function questionAsked(lastMessage: string | undefined, transcriptPath: string | undefined, read: (path: string) => string): string {
  const said = lastMessage?.trim() ?? "";
  if (said !== "") return said;
  if (transcriptPath === undefined) return "";
  try {
    return lastAssistantText(read(transcriptPath));
  } catch {
    return "";
  }
}

/** The plain markdown files of a plan folder of 1 MB or less, by name: the files the board attaches (`planFiles` in `pool-settle.ts`). Anything else it leaves out, and the board refuses the plan for it. */
function planFileNames(planDir: string): string[] {
  if (!existsSync(planDir)) return [];
  return readdirSync(planDir).sort().filter((name) => {
    const info = lstatSync(join(planDir, name));
    return info.isFile() && name.endsWith(".md") && info.size <= PLAN_FILE_BYTES;
  });
}

/** Whether a plan check may refuse a stop once: the outcome says `planned`, the list the brief wrote for the check is there (`given`), and the mark of the retry (`retried`) is not. */
function retryDue(outcomeText: string, io: StopIo, { given, retried }: Readonly<{ given: string; retried: string }>): boolean {
  if (io.exists(retried) || !io.exists(given)) return false;
  const checked = checkOutcome(outcomeText);
  return !("problem" in checked) && checked.outcome.kind === "planned";
}

/**
 * The one automatic retry of a plan that misses a blocker pull request (A11-207): a `planned` outcome, a brief that listed pull requests (`findings-given.json`), no retry made yet (`findings-retried.json`),
 * and a plan folder, without a question, whose plan files fail the check the board's settle step applies (`blocker-findings-check.ts`). The mark is written, the outcome is marked stale, and the stop is refused with the missing
 * addresses and the line form, which Claude Code hands back to the planner's own session. Null when the stop stands; a result allowing the stop, out loud, when the list or a plan cannot be read, since the
 * board's own check is the backstop.
 */
function findingsRetry(ticketDir: string, { text, mtime }: OutcomeRead, io: StopIo): HookResult | null {
  const given = join(ticketDir, FINDINGS_GIVEN_FILE);
  const retried = join(ticketDir, FINDINGS_RETRIED_FILE);
  if (!retryDue(text, io, { given, retried })) return null;
  try {
    const rows = parseFindingsGiven(io.read(given));
    if (rows === null) return { code: 0, say: [`ticket:hook: ${given} is not a list of tickets, so the plan was not checked and the stop is ALLOWED.`] };
    const misses = rows.flatMap(({ key, planDir, urls }) => {
      const names = urls.length === 0 || io.exists(join(planDir, QUESTION_FILE)) ? [] : io.planNames(planDir);
      const miss = names.length === 0 ? null : findingsMiss(names.map((name) => io.read(join(planDir, name))), urls);
      return miss === null ? [] : [{ key, planDir, missing: miss.missing }];
    });
    if (misses.length === 0) return null;
    io.write(retried, `${JSON.stringify({ at: Date.now(), missing: Object.fromEntries(misses.map(({ key, missing }) => [key, missing])) })}\n`);
    // The `planned` outcome stays on disk while the planner fixes its plan, so it is marked stale: the board reads a run that is idle with an outcome as over, and must not settle the plan that was just refused.
    io.write(join(ticketDir, STALE_OUTCOME_FILE), `${mtime}\n`);
    return refuse(retryAsk(misses, join(ticketDir, OUTCOME_FILE)));
  } catch (err) {
    return { code: 0, say: [`ticket:hook: could not check the plan against ${given} (${String((err as Error)?.message ?? err).split("\n")[0]}), so the stop is ALLOWED and the board's check decides.`] };
  }
}

/**
 * The plans of a planning run, by ticket: each ticket's plan folder and the paths its plan claims, from the list the brief wrote beside the outcome (it names every ticket of the run and its plan folder).
 * A ticket with a question, or with no plan file, claims none. Null when the list is missing or is not one.
 */
function planClaims(ticketDir: string, io: StopIo): { key: string; planDir: string; paths: string[] }[] | null {
  const listed = join(ticketDir, FINDINGS_GIVEN_FILE);
  const rows = io.exists(listed) ? parseFindingsGiven(io.read(listed)) : null;
  return rows === null ? null : rows.map(({ key, planDir }) => {
    const names = io.exists(join(planDir, QUESTION_FILE)) ? [] : io.planNames(planDir);
    return { key, planDir, paths: names.flatMap((name) => planClaimPaths(io.read(join(planDir, name)))) };
  });
}

/** The order a batch planner wrote beside its tickets' plan folders (`order.json`), or null for a ticket planned alone, a batch that wrote none yet, or one the board would refuse (which sequences nothing). */
function batchOrder(plans: readonly Readonly<{ key: string; planDir: string }>[], io: StopIo): Order | null {
  if (plans.length < 2) return null;
  const file = join(dirname(plans[0].planDir), ORDER_FILE);
  if (!io.exists(file)) return null;
  const parsed = parseOrder(io.read(file), plans.map(({ key }) => key));
  return "order" in parsed ? parsed.order : null;
}

/**
 * The one automatic retry of a plan that claims a folder other tickets write into (A11-212): a `planned` outcome, a brief that listed the paths other tickets hold, no retry made yet,
 * and a plan folder, without a question, whose paths fail the check the board's settle step applies (`path-claims.ts`). For a batch the tickets are also checked against each other, unless the batch's `order.json` orders
 * them. The mark is written, the outcome is marked stale, and the stop is refused with the folders and the narrower forms. Null when the stop stands; a result allowing the stop, out loud, when the list cannot be read, since the
 * board's own check is the backstop.
 */
function claimsRetry(ticketDir: string, { text, mtime }: OutcomeRead, io: StopIo): HookResult | null {
  const given = join(ticketDir, CLAIMS_GIVEN_FILE);
  const retried = join(ticketDir, CLAIMS_RETRIED_FILE);
  if (!retryDue(text, io, { given, retried })) return null;
  try {
    const held = parseClaimsGiven(io.read(given));
    if (held === null) return { code: 0, say: [`ticket:hook: ${given} is not a list of held paths, so the plan was not checked and the stop is ALLOWED.`] };
    const plans = planClaims(ticketDir, io);
    if (plans === null) return { code: 0, say: [`ticket:hook: the list of this run's plan folders beside ${given} is missing or is not a list, so the plan was not checked and the stop is ALLOWED.`] };
    const order = batchOrder(plans, io);
    const misses = plans.flatMap(({ key, planDir, paths }) => {
      const folders = folderClaimMisses(paths, [...held, ...siblingClaims(key, plans, order)]);
      return folders.length === 0 ? [] : [{ key, planDir, folders }];
    });
    if (misses.length === 0) return null;
    io.write(retried, `${JSON.stringify({ at: Date.now(), folders: misses.flatMap(({ folders }) => folders.map(({ folder }) => folder)) })}\n`);
    // The `planned` outcome stays on disk while the planner narrows its plan, so it is marked stale: the board reads a run that is idle with an outcome as over, and must not settle the plan that was just refused.
    io.write(join(ticketDir, STALE_OUTCOME_FILE), `${mtime}\n`);
    return refuse(claimsRetryAsk(misses, join(ticketDir, OUTCOME_FILE)));
  } catch (err) {
    return { code: 0, say: [`ticket:hook: could not check the plan against ${given} (${String((err as Error)?.message ?? err).split("\n")[0]}), so the stop is ALLOWED and the board's check decides.`] };
  }
}

/**
 * The Stop verdict: allowed once the outcome file is there and passes the contract, refused with what to fix otherwise, up to
 * {@link MAX_STOP_REFUSALS} in a row. A `working` outcome allows one stop, and only while the session has live background work to wake it
 * (`transcriptPath`); a later stop on the same file, by its time, is refused the same way, so a worker its background work woke says how the run stands now.
 * A grill run that ends its turn with no outcome is waiting for the person: that stop is allowed, and its question is recorded for the board (A11-129). A `planned` outcome whose plan misses a blocker
 * pull request its brief listed is refused once, with the missing addresses (A11-207), and so is one that claims a folder other tickets write into, with the narrower paths to use (A11-212).
 */
export function stopVerdict(ticketDir: string, { exists = existsSync, read = (p: string) => readFileSync(p, "utf8"), write = (p: string, t: string) => writeFileSync(p, t),
  readOutcome = readOutcomeFile, planNames = planFileNames, transcriptPath, lastMessage }: {
  exists?: (path: string) => boolean; read?: (path: string) => string; write?: (path: string, text: string) => void;
  readOutcome?: (path: string) => OutcomeRead | null;
  /** The names of the plan files in a plan folder, as the board takes them. */
  planNames?: (planDir: string) => string[];
  transcriptPath?: string;
  /** The message the agent ended its turn with, as the Stop payload carries it. */
  lastMessage?: string;
} = {}): HookResult {
  const outcome = join(ticketDir, OUTCOME_FILE);
  const counter = join(ticketDir, STOP_COUNT_FILE);
  const io: StopIo = { exists, read, write, planNames };
  // The board does not move the outcome while this stop reads it (A11-152). The mark goes when the stop ends, whatever it decided.
  write(join(ticketDir, STOP_ACTIVE_FILE), String(Date.now()));
  try {
    const found = currentOutcome(ticketDir, readOutcome(outcome), io);
    if (found === null && interactiveWriter(ticketDir, io)) {
      write(counter, "0");
      write(join(ticketDir, WAITING_FILE), `${JSON.stringify({ question: questionAsked(lastMessage, transcriptPath, read), at: Date.now() })}\n`);
      return ALLOW;
    }
    const judged: Judgment = found !== null
      ? offListStop(ticketDir, found, io) ?? judgeOutcome({ outcome, stamp: join(ticketDir, WORKING_STOP_FILE), transcriptPath, writer: exists(join(ticketDir, WRITER_FILE)) }, found, io)
      : { ask: `write ${outcome} before you stop, with one of the outcomes your brief lists, such as { "kind": "needs-human", "reason": "..." }.`, stuck: `without ${outcome}, so this one is allowed and the board records no outcome` };
    if ("verdict" in judged) {
      // A plan that misses a blocker pull request is refused once, before the planner ends, and the refusal is no outcome problem: the count is left as it is (A11-207).
      // So is a plan that claims a folder other tickets write into (A11-212), asked after the findings, so that each refusal names one thing to fix.
      const retry = judged.verdict.code === 0 && found !== null ? findingsRetry(ticketDir, found, io) ?? claimsRetry(ticketDir, found, io) : null;
      if (retry?.code === 2) return retry;
      write(counter, "0");
      return retry ?? judged.verdict;
    }
    const refused = exists(counter) ? Number.parseInt(read(counter), 10) || 0 : 0;
    if (refused >= MAX_STOP_REFUSALS) return { code: 0, say: [`ticket-mode: ${refused} stops in a row ${judged.stuck}.`] };
    write(counter, String(refused + 1));
    return refuse(judged.ask);
  } finally {
    rmSync(join(ticketDir, STOP_ACTIVE_FILE), { force: true });
  }
}

/**
 * What a Stop payload gives the verdict: the transcript it names, where Claude Code writes the session, and the message the agent ended its turn with.
 * Each is left out when the payload does not carry it as a string the verdict can use.
 */
function stopPayload(stdin: string): { transcriptPath?: string; lastMessage?: string } {
  try {
    const payload = JSON.parse(stdin) as { transcript_path?: unknown; last_assistant_message?: unknown } | null;
    const path = payload?.transcript_path;
    const message = payload?.last_assistant_message;
    return {
      ...(typeof path === "string" && path !== "" ? { transcriptPath: path } : {}),
      ...(typeof message === "string" ? { lastMessage: message } : {}),
    };
  } catch {
    return {};
  }
}

/** The events the hook answers: the Stop, PreToolUse and PostToolUse hooks a worker's settings name (`worker-files.ts`'s `workerSettings`). */
const HOOK_EVENTS: readonly string[] = ["stop", "pre-tool-use", "post-tool-use"];

export function main(stdin: string, argv: string[]): HookResult {
  const [event, ticketDir] = argv;
  if (!HOOK_EVENTS.includes(String(event)) || !ticketDir) {
    return { code: 0, say: [`ticket:hook: usage is ticket:hook stop|pre-tool-use|post-tool-use <ticket dir>, so this call is ALLOWED.`] };
  }
  try {
    if (event === "stop") return stopVerdict(ticketDir, stopPayload(stdin));
    const payload = JSON.parse(stdin) as { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown };
    const tool = String(payload.tool_name ?? "");
    if (event === "post-tool-use") return recordCreated(ticketDir, tool, payload.tool_response);
    const input = payload.tool_input ?? {};
    const { refusals, note } = machineRefusals(ticketDir);
    const allowed = machineConnectors(ticketDir);
    const guarded = protectedFiles(ticketDir);
    const resolved = typeof input.file_path === "string" ? { ...input, file_path: resolveWritePath(input.file_path) } : input;
    const verdict = toolVerdict(tool, resolved, {
      machine: refusals, connectors: allowed.connectors, approved: approvedPulls(ticketDir), publish: publishConnectors(ticketDir),
      ready: existsSync(join(ticketDir, READY_FILE)), hostPrograms: guarded.paths, writer: existsSync(join(ticketDir, WRITER_FILE)),
      grants: writerGrants(ticketDir), created: readCreatedKeys(ticketDir),
    });
    const review = prReviewSetting(ticketDir);
    // A call the other refusals stopped is neither logged nor gated: it did not run.
    const gated = verdict.code === 0 ? prReviewVerdict(tool, resolved, ticketDir, review) : verdict;
    const notes = [note, allowed.note, guarded.note].filter((n): n is string => n !== undefined);
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
