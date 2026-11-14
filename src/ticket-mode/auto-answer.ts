// @ts-check
// module: the answerer -- a cheap model answers a run's question from what is written down, before the run is parked for a person (A11-438)
//
// A WRONG CONFIDENT ANSWER IS WORSE THAN A WAIT. The answerer takes only the questions {@link mayAnswer} names: those that name no item of the escalation list (the board marks them off the list) and those under
// `reserved` or `contradicts`, whose answer is a decision a person may already have written down. Money and access, anything outward-facing, discarding work, frozen settings and legal questions always reach a person.
// The model is given only the sources {@link sourcesFor} reads, and must cite at least one of them by its label; an answer under the threshold, one that cites nothing it was given, or one that cannot be read is no
// answer, and the run is parked as before.
//
// THE ANSWER IS NOT A PERSON'S DECISION. It is never written into the ticket's `## Decisions`, which only a person's answer through the answer route writes (`pool-answer.ts`) and which a reviewer honours as a
// person's. The run is told it is an automatic answer, to follow it and to list it under "Decisions made without a person" with its sources, as it would its own choice.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { escalationItem } from "./escalation.ts";
import type { AnswerSource, AutoAnswer } from "./queue/auto-answer-record.ts";
import type { Entry, Outcome } from "./queue/queue-entries-and-outcomes.ts";
import type { AutoAnswerSettings } from "./settings.ts";
import { decisionsOf } from "./ticket-decisions.ts";

/** The items of the escalation list a question may name and still be answered automatically: decisions a person may have written down already. Every other item reaches a person. */
export const ANSWERABLE_ITEMS: ReadonlySet<string> = new Set(["reserved", "contradicts"]);

/** The most characters of one source the model is given, and of all of them together. */
export const SOURCE_CHARS = 12_000;
export const SOURCES_CHARS = 60_000;

/** The repository files read as its docs, in each worktree the run made. */
const REPO_DOCS = ["AGENTS.md", "CLAUDE.md", "README.md"] as const;

/** The longest the model is waited for: a question it has not answered by then is parked for a person. */
export const ANSWER_TIMEOUT_MS = 120_000;

/** One source the model reads: what it is cited by, where it is when it has an address, and its text. */
export type Source = AnswerSource & Readonly<{ text: string }>;

/** What the model is asked with, and answers in its own words: the prompt, and the model's name. Throws when it cannot be asked. */
export type Answerer = (prompt: string, model: string) => Promise<string>;

/** What the model answered, read: the answer, how sure it is, and the labels of the sources it cites. */
export type Reply = Readonly<{ answer: string; confidence: number; sources: readonly string[] }>;

/** What came of asking: an answer the run is sent, or why the question is parked for a person. */
export type Decided = Readonly<{ answered: Omit<AutoAnswer, "question" | "at"> }> | Readonly<{ parked: string }>;

/**
 * Whether the answerer may try `outcome` on `entry`'s run: the switch is on, the outcome is a `needs-human` the board could read whose item may be answered ({@link ANSWERABLE_ITEMS}, or none on the list), the run is not a
 * talk session or a batch and has a workspace whose agent can be sent the answer, and the same question was not answered automatically already (a run that asks it again after an automatic answer wants a person). PURE.
 */
export function mayAnswer(settings: AutoAnswerSettings | undefined, entry: Entry, outcome: Outcome): outcome is Extract<Outcome, { kind: "needs-human" }> {
  if (settings?.on !== true || outcome.kind !== "needs-human" || outcome.unreadable === true) return false;
  return hasAgentToTell(entry) && entry.autoAnswer?.question !== outcome.reason.trim() && isAnswerableItem(outcome.escalation);
}

/** Whether a run has an agent of its own the answer can be sent to: not a talk session, whose person is in its terminal, nor a batch's run, and with its workspace open. PURE. */
const hasAgentToTell = (entry: Entry): boolean => entry.talk !== true && entry.batch === undefined && entry.workspace !== undefined;

/** Whether a stop under `escalation` may be answered automatically: it names no item of the list, or one of {@link ANSWERABLE_ITEMS}. PURE. */
const isAnswerableItem = (escalation: string | undefined): boolean => escalationItem(escalation) === undefined || ANSWERABLE_ITEMS.has(escalation ?? "");

/** `text` cut to `max` characters, saying so when it was cut. PURE. */
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n[... cut at ${max} characters]`);

/** The markdown files of a folder, by name, or none when it has none or cannot be read. */
function markdownIn(dir: string): readonly string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md")).sort().map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** The text of a file, or null when it cannot be read. */
function textOf(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * What {@link sourcesFor} reads from: the run, its parent ticket when it has one, the ticket's directory (its attachments, and the parent's under `parent/`), the run's folder (its worktrees, by the names in `entry.repos`),
 * and the other runs on the board.
 */
export type SourceReads = Readonly<{ entry: Entry; parent: Readonly<{ key: string; description: string; url: string }> | null; ticketDir: string; folder: string; others: readonly Entry[] }>;

/** The sources kept, in order, while their texts add up to no more than {@link SOURCES_CHARS}. PURE. */
function withinBudget(sources: readonly Source[]): readonly Source[] {
  const kept: Source[] = [];
  let spent = 0;
  for (const source of sources) {
    spent += source.text.length;
    if (spent > SOURCES_CHARS) break;
    kept.push(source);
  }
  return kept;
}

/**
 * The sources the model is given, in the order it should trust them: the ticket, its parent, the files attached to each (the plan among them), the docs of each repository the run made a worktree in, and the Decisions
 * entries of the other tickets on the board, which are past answers a person gave. Each is cut to {@link SOURCE_CHARS}, and the list ends before {@link SOURCES_CHARS} in all. Reads files only; never throws.
 */
export function sourcesFor({ entry, parent, ticketDir, folder, others }: SourceReads): readonly Source[] {
  const { ticket } = entry;
  const files = (dir: string, owner: string): Source[] =>
    markdownIn(dir).flatMap((path) => { const text = textOf(path); return text === null || basename(path) === "brief.md" ? [] : [{ label: `${owner}'s file ${basename(path)}`, text }]; });
  const docs = entry.repos.flatMap((repo) => REPO_DOCS.flatMap((name) => {
    const path = join(folder, repo, name);
    const text = existsSync(path) ? textOf(path) : null;
    return text === null ? [] : [{ label: `${repo}'s ${name}`, text }];
  }));
  const decided = others.flatMap((other) => {
    const decisions = other.ticket.key === ticket.key ? null : decisionsOf(other.ticket.description);
    return decisions === null ? [] : [{ label: `the Decisions of ${other.ticket.key}`, url: other.ticket.url, text: decisions }];
  });
  const all: Source[] = [
    { label: `the ticket ${ticket.key}`, url: ticket.url, text: ticket.description },
    ...(parent === null ? [] : [{ label: `the parent ticket ${parent.key}`, url: parent.url, text: parent.description }]),
    ...files(ticketDir, ticket.key), ...(parent === null ? [] : files(join(ticketDir, "parent"), parent.key)), ...docs, ...decided,
  ];
  return withinBudget(all.filter(({ text }) => text.trim() !== "").map((source) => ({ ...source, text: cut(source.text, SOURCE_CHARS) })));
}

/** The prompt: the question, every source under its label, and the one JSON object the model answers with. PURE. */
export function answerPrompt(question: string, sources: readonly Source[]): string {
  const quoted = sources.map(({ label, text }) => `<source label="${label}">\n${text}\n</source>`).join("\n\n");
  return [
    "An unattended software worker stopped to ask a person the question below. Answer it ONLY if the sources below already settle it: a decision written down, a name stated, a rule given.",
    "Do not guess, do not reason from what is usual, and do not decide anything the sources leave open: then answer with confidence 0.",
    "Reply with ONE JSON object and nothing else: {\"answer\": \"<the answer, in one or two sentences>\", \"confidence\": <0 to 1, how sure you are the sources settle it>, \"sources\": [\"<the label of each source that says so>\"]}.",
    "",
    `<question>\n${question.trim()}\n</question>`,
    "",
    quoted,
  ].join("\n");
}

/** The JSON object in a reply: the reply itself, or the first `{` to the last `}`, which drops a fence or a sentence around it. Null when there is none. PURE. */
function objectIn(text: string): unknown {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from === -1 || to < from) return null;
  try {
    return JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
}

/** The reply read, or null when it is not the object the prompt asks for: a non-empty answer, a confidence from 0 to 1, and a list of labels. PURE. */
export function replyOf(text: string): Reply | null {
  const read = objectIn(text) as { answer?: unknown; confidence?: unknown; sources?: unknown } | null;
  if (read === null || typeof read !== "object") return null;
  const { answer, confidence, sources } = read;
  if (!isAnswerText(answer) || !isConfidence(confidence) || !isLabelList(sources)) return null;
  return { answer: answer.trim(), confidence, sources };
}

/** Whether a reply's answer is text with something in it. PURE. */
const isAnswerText = (answer: unknown): answer is string => typeof answer === "string" && answer.trim() !== "";

/** Whether a reply's confidence is a number from 0 to 1. PURE. */
const isConfidence = (confidence: unknown): confidence is number => typeof confidence === "number" && confidence >= 0 && confidence <= 1;

/** Whether a reply's sources are a list of labels. PURE. */
const isLabelList = (sources: unknown): sources is string[] => Array.isArray(sources) && sources.every((label) => typeof label === "string");

/**
 * What the reply comes to at `threshold`: answered, with the sources it cites that it was given (their addresses kept), or parked with why: it could not be read, it is under the threshold, or it cites none of the sources.
 * PURE.
 */
export function decide(text: string, sources: readonly Source[], threshold: number): Decided {
  const reply = replyOf(text);
  if (reply === null) return { parked: "the answerer's reply could not be read" };
  if (reply.confidence < threshold) return { parked: `the answerer was ${percent(reply.confidence)} sure, under the ${percent(threshold)} it needs` };
  const cited = sources.filter(({ label }) => reply.sources.includes(label)).map(({ label, url }) => (url === undefined ? { label } : { label, url }));
  if (cited.length === 0) return { parked: "the answerer cited none of the sources it was given" };
  return { answered: { answer: reply.answer, confidence: reply.confidence, sources: cited } };
}

/** A confidence from 0 to 1 as a whole percentage, such as `95%`. PURE. */
export const percent = (confidence: number): string => `${Math.round(confidence * 100)}%`;

/** The result text of a `claude -p --output-format json` run, or the output as it is when it is not that. PURE. */
export function resultOf(stdout: string): string {
  try {
    const read = JSON.parse(stdout.trim().split("\n").pop() ?? "") as { result?: unknown };
    return typeof read?.result === "string" ? read.result : stdout;
  } catch {
    return stdout;
  }
}

/**
 * Ask the model through the `claude` command: headless, with no tools and no MCP server, in an empty folder of its own so no project's settings or hooks apply, the prompt on its stdin. Throws when it fails or runs past
 * {@link ANSWER_TIMEOUT_MS}.
 */
export const askClaude: Answerer = (prompt, model) => new Promise((resolve, reject) => {
  const child = execFile("claude", ["-p", "--model", model, "--output-format", "json", "--strict-mcp-config", "--no-session-persistence", "--tools", ""],
    { cwd: mkdtempSync(join(tmpdir(), "auto-answer-")), timeout: ANSWER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout) => (err === null ? resolve(resultOf(stdout)) : reject(err)));
  child.stdin?.end(prompt);
});

/** The message the run is sent: the question, the automatic answer with its sources, and what to do with it. PURE. */
export function messageOf(question: string, { answer, confidence, sources }: Omit<AutoAnswer, "question" | "at">): string {
  const quoted = (text: string): string => text.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
  const cited = sources.map(({ label, url }) => `- ${label}${url === undefined ? "" : ` (${url})`}`).join("\n");
  return `The board answered your question automatically, from what is already written down (${percent(confidence)} sure). No person has seen it yet.\n\nYour question:\n\n${quoted(question)}\n\n`
    + `The answer:\n\n${quoted(answer)}\n\nIts sources:\n\n${cited}\n\n`
    + "Carry on with this answer. It is not a person's decision: list it under \"Decisions made without a person\" in your pull request body, with these sources, and never write that a person decided it. "
    + "A person may still overrule it through the board, and you will be told. Write the outcome file again as the last thing you do.";
}
