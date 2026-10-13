#!/usr/bin/env node
// @ts-check
// command: ticket:hook -- the Stop and PreToolUse hook every ticket-mode worker runs under: `ticket:hook stop|pre-tool-use <ticket dir>`
//
// STOP: A RUN ENDS ON AN OUTCOME FILE. A worker that stops without writing one leaves the board with nothing to show, so the stop is refused with
// the file's path, at most twice in a row, after which it is allowed and the pool records `no-outcome`. It does NOT honour `stop_hook_active`, as
// `worker-stop-hook.ts` does: the nbl-ui plugin's own Stop gates block once and then let the next stop through on that flag, and a hook that also
// honoured it would let a worker end on that second stop with no outcome. Its own count is what bounds it.
//
// PRE-TOOL-USE: WHAT ONLY A PERSON DOES. A worker opens a DRAFT pull request and stops. Marking it ready, requesting a review, merging, force-pushing,
// running a workflow and posting to Slack are the person's, and so is every connector the machine does not name. A worker runs with the person's
// connectors, Slack and mail among them, so a connector is refused unless the host file's `tickets.connectors` lets its tool name through: a
// machine whose tickets live in Linear names Linear's reads, and its worker can read a ticket's parent and blockers there. The host file's
// `tickets.deny` adds this machine's own command refusals. The pool copies both beside the outcome file. A refusal is exit 2 with the reason on
// stderr, which Claude Code hands back to the model.
//
// IT FAILS OPEN, OUT LOUD, for a payload or a count it cannot read: a hook that refused on what it could not read would stop every worker.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DenyRule } from "./settings.ts";
import { CONNECTORS_FILE, DENY_FILE, OUTCOME_FILE, STOP_COUNT_FILE } from "./worker-files.ts";

export type HookResult = Readonly<{ code: 0 | 2; say: readonly string[] }>;

export const MAX_STOP_REFUSALS = 2;

const ALLOW: HookResult = { code: 0, say: [] };
const refuse = (reason: string): HookResult => ({ code: 2, say: [`ticket-mode: ${reason}`] });

type Refusal = Readonly<{ pattern: RegExp; why: string }>;

/** Each command a ticket-mode worker may not run, and why. Matched against the Bash tool's whole command line. */
const BASH_REFUSALS: readonly Refusal[] = [
  { pattern: /\bgh\s+pr\s+(ready|merge|review)\b/, why: "marking ready, merging and reviewing are the person's" },
  { pattern: /--add-reviewer\b|--reviewer\b/, why: "requesting a review is the person's" },
  { pattern: /\bgh\s+workflow\s+run\b/, why: "running a workflow is the person's" },
  { pattern: /\bgit\s+push\b[^\n;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/, why: "a force push rewrites what someone may have read" },
  { pattern: /\bassumego\b/, why: "it prints credentials into the session" },
];

const SKILL_REFUSALS: readonly Refusal[] = [
  { pattern: /post-pr-to-slack/, why: "announcing a pull request is the person's" },
];

/**
 * The PreToolUse verdict for one tool call. `machine` holds this machine's own Bash refusals, after the built-in ones, and `connectors` the
 * connector tool names it allows. PURE.
 */
export function toolVerdict(toolName: string, input: Record<string, unknown>, machine: readonly Refusal[] = [], connectors: readonly RegExp[] = []): HookResult {
  if (toolName.startsWith("mcp__")) {
    return connectors.some((pattern) => pattern.test(toolName)) ? ALLOW : refuse(`${toolName} is a connector this machine's tickets.connectors does not allow`);
  }
  if (toolName === "Skill") {
    const skill = String(input.skill ?? input.name ?? "");
    const hit = SKILL_REFUSALS.find(({ pattern }) => pattern.test(skill));
    return hit ? refuse(`the ${skill} skill is refused: ${hit.why}`) : ALLOW;
  }
  if (toolName !== "Bash") return ALLOW;
  const command = String(input.command ?? "");
  if (/\bgh\s+pr\s+create\b/.test(command) && !/--draft\b/.test(command)) return refuse("open the pull request as a draft: `gh pr create --draft`");
  const hit = [...BASH_REFUSALS, ...machine].find(({ pattern }) => pattern.test(command));
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

/** The Stop verdict: allowed once the outcome file is there, refused with its path otherwise, up to {@link MAX_STOP_REFUSALS} in a row. */
export function stopVerdict(ticketDir: string, { exists = existsSync, read = (p: string) => readFileSync(p, "utf8"), write = (p: string, t: string) => writeFileSync(p, t) }: {
  exists?: (path: string) => boolean; read?: (path: string) => string; write?: (path: string, text: string) => void;
} = {}): HookResult {
  const outcome = join(ticketDir, OUTCOME_FILE);
  const counter = join(ticketDir, STOP_COUNT_FILE);
  if (exists(outcome)) {
    write(counter, "0");
    return ALLOW;
  }
  const refused = exists(counter) ? Number.parseInt(read(counter), 10) || 0 : 0;
  if (refused >= MAX_STOP_REFUSALS) {
    return { code: 0, say: [`ticket-mode: ${refused} stops in a row without ${outcome}, so this one is allowed and the board records no outcome.`] };
  }
  write(counter, String(refused + 1));
  return refuse(`write ${outcome} before you stop: { "kind": "draft-pr", "prs": [...] }, { "kind": "wrong-repo", "where": "..." } or { "kind": "needs-human", "reason": "..." }.`);
}

export function main(stdin: string, argv: string[]): HookResult {
  const [event, ticketDir] = argv;
  if ((event !== "stop" && event !== "pre-tool-use") || !ticketDir) return { code: 0, say: [`ticket:hook: usage is ticket:hook stop|pre-tool-use <ticket dir>, so this call is ALLOWED.`] };
  try {
    if (event === "stop") return stopVerdict(ticketDir);
    const payload = JSON.parse(stdin) as { tool_name?: string; tool_input?: Record<string, unknown> };
    const { refusals, note } = machineRefusals(ticketDir);
    const allowed = machineConnectors(ticketDir);
    const verdict = toolVerdict(String(payload.tool_name ?? ""), payload.tool_input ?? {}, refusals, allowed.connectors);
    const notes = [note, allowed.note].filter((n): n is string => n !== undefined);
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
