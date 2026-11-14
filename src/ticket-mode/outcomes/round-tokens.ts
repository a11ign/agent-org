// @ts-check
// module: the tokens of one round of a run (A11-430) -- the turns a Claude transcript holds, the ones a round made, and a batch's share of them
//
// ONE API MESSAGE IS WRITTEN ONCE PER CONTENT BLOCK, each record repeating the message's usage (`src/trace/store.ts` measured 23 records for 8 messages), so a turn is one
// `message.id`, read from its LAST record, whose `output_tokens` is the final figure. The usage is read with the trace store's own `tokensOf` (`src/trace/tokens.ts`), so the cost the trace prices
// and the cost an outcome record is priced at come from the same split of input, output, cache reads and cache writes.
//
// A ROUND OWNS THE TURNS MADE AFTER THE ROUND BEFORE IT ENDED. A review round resumes the same Claude session, so its transcript holds every earlier round's turns too, and a
// resume that copies them keeps their message ids and times. Counting only the turns stamped after the previous round's end gives each turn to the round that made it, once.

import { existsSync, readFileSync } from "node:fs";
import { type Tokens, tokensOf } from "../../trace/tokens.ts";

/** One model turn of a transcript: its API message id, when its last block was written, the model that answered it and its usage. */
export type Turn = Readonly<{ id: string; at: number; model: string; tokens: Tokens }>;

/** Tokens by the model that spent them: a session that changes model mid-run is priced by each. */
export type ModelTokens = Readonly<Record<string, Tokens>>;

/** What reading a transcript gave: its turns, or why it could not be read. */
export type TranscriptRead = Readonly<{ turns: readonly Turn[] }> | Readonly<{ unreadable: string }>;

/** The model a turn is filed under when its record names none. */
export const UNKNOWN_MODEL = "unknown";

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

type UsageRecord = { type?: string; timestamp?: string; message?: { id?: string; model?: string; usage?: unknown } };

/**
 * The turns of the transcript at `file`, one per API message. A transcript that is missing, cannot be read, or has a line that is not JSON anywhere but at its end (a live transcript's
 * last line is often half written) is unreadable, with the reason: its tokens are unknown, never 0.
 */
export function readTurns(file: string | null): TranscriptRead {
  if (file === null) return { unreadable: "no transcript was found for the run's Claude session" };
  if (!existsSync(file)) return { unreadable: `its transcript ${file} is missing` };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { unreadable: `its transcript ${file} could not be read (${(err as Error).message})` };
  }
  const lines = text.split("\n");
  const byMessage = new Map<string, Turn>();
  for (const [index, line] of lines.entries()) {
    if (!line.includes("\"usage\"")) continue;
    const turn = turnOf(line);
    if (turn === "not-json" && index !== lines.length - 1) return { unreadable: `line ${index + 1} of its transcript ${file} is not JSON` };
    if (turn !== "not-json" && turn !== null) byMessage.set(turn.id, turn);
  }
  return { turns: [...byMessage.values()] };
}

/** The turn one transcript line records, null for a line that records none (a user's message that quotes `"usage"`), or `not-json`. PURE. */
function turnOf(line: string): Turn | null | "not-json" {
  let record: UsageRecord;
  try {
    record = JSON.parse(line) as UsageRecord;
  } catch {
    return "not-json";
  }
  const id = record.type === "assistant" ? record.message?.id : undefined;
  if (id === undefined || record.message?.usage === undefined) return null;
  return { id, at: Date.parse(record.timestamp ?? ""), model: record.message.model ?? UNKNOWN_MODEL, tokens: tokensOf(record.message.usage) };
}

/** `a` and `b` added field by field. PURE. */
export const addTokens = (a: Tokens, b: Tokens): Tokens => Object.fromEntries(TOKEN_FIELDS.map((field) => [field, a[field] + b[field]])) as Tokens;

/** Each model's tokens of `parts`, added up. PURE. */
export function addModelTokens(parts: readonly ModelTokens[]): ModelTokens {
  const sum: Record<string, Tokens> = {};
  for (const part of parts) for (const [model, tokens] of Object.entries(part)) sum[model] = addTokens(sum[model] ?? NO_TOKENS, tokens);
  return sum;
}

/**
 * The tokens of the turns a round made: those stamped after `after`, the time the run's previous round ended, or every turn for a run's first round (`after` undefined). A turn with no
 * readable time belongs to the first round only, so a later round never takes one an earlier round counted. PURE.
 */
export function roundTokens(turns: readonly Turn[], after: number | undefined): ModelTokens {
  const own = turns.filter(({ at }) => (after === undefined ? true : at > after));
  return addModelTokens(own.map(({ model, tokens }) => ({ [model]: tokens })));
}

/**
 * The share of `tokens` the `index`th of `count` tickets of a batch carries (A11-430). THE SPLIT RULE: every count is divided evenly, and the tokens left over by the division go one each
 * to the first tickets in the batch's order, so the shares are whole tokens and add up to the run's total exactly. A planning run plans its tickets together, and its transcript does not say
 * which turn was for which ticket, so an even split is the only one the transcript supports. PURE.
 */
export function batchShare(tokens: ModelTokens, index: number, count: number): ModelTokens {
  const share = (total: number): number => Math.floor(total / count) + (index < total % count ? 1 : 0);
  return Object.fromEntries(Object.entries(tokens).map(([model, each]) => [model, Object.fromEntries(TOKEN_FIELDS.map((field) => [field, share(each[field])])) as Tokens]));
}

/** The input and output of `tokens`, as a run's Properties show them: input counts cache reads and writes, which are what a run spends. PURE. */
export function inputOutputOf(tokens: ModelTokens): Readonly<{ input: number; output: number }> {
  const all = Object.values(tokens).reduce(addTokens, NO_TOKENS);
  return { input: all.input + all.cacheRead + all.cacheWrite5m + all.cacheWrite1h, output: all.output };
}
