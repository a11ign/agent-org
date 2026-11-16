#!/usr/bin/env node
// A11-438, step 2: `node scripts/replay-auto-answer.ts` replays the past Needs-you questions a person answered through the answerer, and stores the score. The logic is `src/ticket-mode/auto-answer-replay.ts`; the
// real model calls live here.
//
// THE SET IS THE HOST'S, NOT THE REPOSITORY'S. agent-org is public and the questions, answers and tickets are the organisation's own, so the set is read from `<stateDir>/evals/auto-answer/answered.json` (or `--set`),
// the full result is written beside it, and only the public result (`publicResultOf`: keys, outcomes, confidence, agreement and the score) is written to `evals/auto-answer/result.json` in this checkout.
//
// OFFLINE BUT FOR THE MODEL. The set holds each question's sources as they stood before the person answered, so nothing reads the tracker, the code host or a run. The answerer and the judge are
// `claude -p` with no tools and no MCP server, in an empty folder of their own, as the board asks the answerer (`askClaude`). The run stops before a question once the tokens spent reach `tickets.evalTokenCap`
// (A11-429: evals have a token cap in config), and the result says it was capped. The answerer's threshold and model are the host file's (`tickets.autoAnswerThreshold`, `tickets.autoAnswerModel`); `--threshold`, `--model` and `--judge` override them and the judge's model.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_TIMEOUT_MS, resultOf } from "../src/ticket-mode/auto-answer.ts";
import { judgementOf, judgePrompt, publicResultOf, replay, scoreOf, verdictOf, type ReplayCase, type ReplayResult } from "../src/ticket-mode/auto-answer-replay.ts";
import { readTicketSettings } from "../src/ticket-mode/settings.ts";
import { tokensOfResult } from "../src/run-eval/worker.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The value after `--name` on the command line, or `fallback`. */
const option = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1] ?? fallback;
};


let spentTokens = 0;

/** Ask `model` through `claude -p`, as `askClaude` does, and add the tokens it reports to {@link spentTokens}. */
const claude = (prompt: string, model: string): Promise<string> => new Promise((resolve, reject) => {
  const child = execFile("claude", ["-p", "--model", model, "--output-format", "json", "--strict-mcp-config", "--no-session-persistence", "--tools", ""],
    { cwd: mkdtempSync(join(tmpdir(), "auto-answer-replay-")), timeout: ANSWER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout) => {
      spentTokens += tokensOfResult(stdout) ?? 0;
      return err === null ? resolve(resultOf(stdout)) : reject(err);
    });
  child.stdin?.end(prompt);
});

const settings = readTicketSettings();
const { model: liveModel = "haiku", threshold: liveThreshold = 1 } = settings.autoAnswer ?? {};
const setFile = option("set", join(settings.stateDir, "evals", "auto-answer", "answered.json"));
const cases = JSON.parse(readFileSync(setFile, "utf8")) as ReplayCase[];
const model = option("model", liveModel);
const judgeModel = option("judge", "sonnet");
const threshold = Number(option("threshold", String(liveThreshold)));
if (!(threshold > 0 && threshold <= 1)) throw new Error(`--threshold must be a number above 0 and at most 1, not ${option("threshold", "")}`);
const cap = settings.evalTokenCap;

const judge = async (question: string, personAnswer: string, autoAnswer: string) => {
  const read = judgementOf(await claude(judgePrompt(question, personAnswer, autoAnswer), judgeModel));
  if (read === null) throw new Error("the judge's reply could not be read");
  return read;
};

const results = await replay(cases, { ask: claude, model, judge, threshold }, () => spentTokens >= cap);
const score = scoreOf(results);
const capped = results.length < cases.length;
const verdict = `${verdictOf(score)}${capped ? ` Capped at ${cap} tokens after ${results.length} of ${cases.length} questions.` : ""}`;
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const stored: ReplayResult = { ranAt: new Date().toISOString(), sha, model, judgeModel, threshold, capped, score, verdict, results };
mkdirSync(dirname(setFile), { recursive: true });
writeFileSync(join(dirname(setFile), "result.json"), `${JSON.stringify(stored, null, 2)}\n`);
writeFileSync(join(root, "evals", "auto-answer", "result.json"), `${JSON.stringify(publicResultOf(stored), null, 2)}\n`);
process.stdout.write(`${verdict}\nTokens spent: ${spentTokens}.\n`);
