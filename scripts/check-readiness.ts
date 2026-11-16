#!/usr/bin/env node
// A11-443, step 2: `node scripts/check-readiness.ts` scores past tickets with the live readiness scorer and sets the scores against how their runs went, then stores the result. The logic is
// `src/ticket-mode/readiness-check.ts`; the real model calls live here.
//
// THE SET IS THE HOST'S, NOT THE REPOSITORY'S. agent-org is public and the tickets' text is the organisation's own, so the tickets are read from `<stateDir>/evals/readiness/tickets.json` (or `--set`):
// a list of `{ key, title, project, description }`, as the Tickets page holds them. The full result (with the model's reasons) is written beside it, and only the public result (`publicResultOf`:
// keys, scores and the board's counts) is written to `evals/readiness/result.json` in this checkout.
//
// THE SCORE IS THE BOARD'S. Each ticket is asked with the board's own prompt, model and bounds (`readinessPrompt`, `READINESS_BOUNDS`, `askHeadless`) and its reply read the board's way (`scoreOf`).
// How its runs went is read from the host's outcome log (`<stateDir>/tickets/outcomes.jsonl`) and the queue's run log (`<stateDir>/tickets/queue.json`). The set is the first MAX_SET tickets of
// the outcome log by first run (`pickSet`); a picked ticket missing from the set file stops the check, naming it. The check stops before a ticket once the tokens spent reach
// `tickets.evalTokenCap` (A11-429: evals have a token cap in config), and the result says it was capped.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askHeadless } from "../src/ticket-mode/headless-claude.ts";
import { readOutcomes, outcomesPath } from "../src/ticket-mode/outcomes/outcome-record.ts";
import type { RunEvent } from "../src/ticket-mode/queue/run-log.ts";
import { READINESS_BOUNDS, readinessPrompt, scoreOf } from "../src/ticket-mode/readiness.ts";
import { historiesOf, linkOf, pickSet, publicResultOf, verdictOf, type CheckedResult, type CheckResult } from "../src/ticket-mode/readiness-check.ts";
import { replyOf } from "../src/ticket-mode/retro/retro-prompt.ts";
import { readTicketSettings } from "../src/ticket-mode/settings.ts";
import { realExecAsync } from "../src/plugins/real-seams.ts";
import { tokensOfResult } from "../src/run-eval/worker.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The value after `--name` on the command line, or `fallback`. */
const option = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1] ?? fallback;
};

type SetTicket = Readonly<{ key: string; title: string; project: string | null; description: string }>;

const settings = readTicketSettings();
const setFile = option("set", join(settings.stateDir, "evals", "readiness", "tickets.json"));
const known = new Map((JSON.parse(readFileSync(setFile, "utf8")) as SetTicket[]).map((ticket) => [ticket.key, ticket]));
const records = readOutcomes(outcomesPath(settings.stateDir));
const queue = JSON.parse(readFileSync(join(settings.stateDir, "tickets", "queue.json"), "utf8")) as { runLog?: Record<string, RunEvent[]> };
const histories = historiesOf(records, queue.runLog ?? {});
const picked = pickSet(records);
const missing = picked.filter((key) => !known.has(key));
if (missing.length > 0) throw new Error(`${setFile} has no text for ${missing.join(", ")}: add each picked ticket's key, title, project and description`);

const ask = askHeadless(realExecAsync, mkdtempSync(join(tmpdir(), "readiness-check-")), READINESS_BOUNDS);
let spentTokens = 0;

/** One picked ticket scored by the board's scorer, with its history. A reply that holds no score is kept as failed, and left out of the comparison. */
async function checked(key: string): Promise<CheckedResult> {
  const history = histories.get(key)!;
  const answer = await ask(readinessPrompt({ ...known.get(key)!, project: known.get(key)!.project ?? undefined }));
  spentTokens += tokensOfResult(answer.stdout) ?? 0;
  const reply = answer.status === 0 ? replyOf(answer.stdout) : null;
  const scored = reply === null ? null : scoreOf(reply);
  if (scored === null) return { ...history, score: null, reasons: [], failed: `exit ${String(answer.status)}: ${(answer.stderr || answer.stdout).trim().split("\n")[0] ?? ""}` };
  return { ...history, score: scored.score, reasons: scored.reasons };
}

const tickets: CheckedResult[] = [];
for (const key of picked) {
  if (spentTokens >= settings.evalTokenCap) break;
  tickets.push(await checked(key));
}
const score = linkOf(tickets);
const capped = tickets.length < picked.length;
const verdict = `${verdictOf(score)}${capped ? ` Capped at ${settings.evalTokenCap} tokens after ${tickets.length} of ${picked.length} tickets.` : ""}`;
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const stored: CheckResult = { ranAt: new Date().toISOString(), sha, model: READINESS_BOUNDS.model, capped, score, verdict, tickets };
mkdirSync(dirname(setFile), { recursive: true });
writeFileSync(join(dirname(setFile), "result.json"), `${JSON.stringify(stored, null, 2)}\n`);
mkdirSync(join(root, "evals", "readiness"), { recursive: true });
writeFileSync(join(root, "evals", "readiness", "result.json"), `${JSON.stringify(publicResultOf(stored), null, 2)}\n`);
process.stdout.write(`${verdict}\nTokens spent: ${spentTokens}.\n`);
