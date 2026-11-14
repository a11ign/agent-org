// @ts-check
// module: what a model's tokens cost -- the price table the trace reads (`PRICES`) and the formula that prices tokens at a table (`costAt`). A LEAF: it imports only the token type, so
// ticket mode's outcome records (A11-430) price their tokens at the table its config names with the same formula the trace store uses, without the store's row-mode imports.
// `store.ts` re-exports `PRICES` and keeps `costOf`, which is `costAt` at this table.
import type { Tokens } from "./tokens.ts";

const TOKENS_PER_MILLION = 1_000_000;
export const COST_PRECISION = 100_000_000; // Claude Code reports cost_usd to 7 places; rounding only removes float noise
const WRITE_5M_FACTOR = 1.25;
const WRITE_1H_FACTOR = 2;

type Rates = { input: number; output: number; cacheRead: number; verified: boolean };

/** One row of a price table: dollars per million tokens for the models it matches, by `prefix` (a Claude id) or by exact `model` (any other vendor's). */
export type PriceRow = Readonly<{ prefix?: string; model?: string; input: number; output: number; cacheRead: number; maxPrompt?: number }>;

/**
 * Dollars per million tokens, `cacheRead` as the pricing page lists it (read 2026-10-08, #4057): the factor on input is not the same for every model (Fable 5.1 $0.25 on a $10 input,
 * Fable 5 $1, Sonnet 5.5 $0.10). `verified` is true where the formula reproduced Claude Code's own `cost_usd` (2026-10-04, #3494); the others are the published rates.
 * A row is NOT verified when it disagrees with the page: `cost_usd` is the client's estimate and the page is the billing rate (Sonnet 5.5, which `cost_usd` priced at the old $0.20).
 * A Claude row matches by `prefix` (ids carry dated suffixes). A row of any OTHER vendor matches by `model`, the EXACT name, and carries `source` (the URL it was quoted from) and `fetched`
 * (the date), because a rate borrowed from a neighbouring model is an invention with a citation on it (#4076, #4055 move 10): `gpt-5.6-luna-pro` is a different model with a different price.
 * `maxPrompt` is the largest prompt (input + cached + cache writes) the listed rates are quoted for: a request above it costs `null`, because the page states a different rate there and not all of it.
 */
export const PRICES: (Rates & { prefix?: string; model?: string; source?: string; fetched?: string; maxPrompt?: number; })[] = [
  // `claude-fable-5-1` stands BEFORE `claude-fable-5`: the page lists them apart, and `costOf` takes the first prefix that matches.
  { prefix: "claude-fable-5-1", input: 10, output: 50, cacheRead: 0.25, verified: false },
  { prefix: "claude-fable-5", input: 10, output: 50, cacheRead: 1, verified: false },
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, verified: false },
  { prefix: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.1, verified: false },
  // The ids before 5.5 (a11ign/a11ign#3582). `costOf` takes the FIRST prefix that matches, so these stand after `-5-5` or they would price its turns. Rates: the claude-api
  // skill's model docs (2026-09-25): Opus 5 $5 / $25 with cache reads at 0.1x ("every other model", Opus 5.5 being 0.05x and Fable 5.1 0.025x), Sonnet 5 at Sonnet 5.5's
  // prices ($2 / $10, reads $0.20). Not reproduced against a `cost_usd`.
  { prefix: "claude-opus-5", input: 5, output: 25, cacheRead: 0.5, verified: false },
  { prefix: "claude-sonnet-5", input: 2, output: 10, cacheRead: 0.2, verified: false },
  // Haiku 5.5 (#4186; found on #4183, where its turns read `costUsd: null`). The claude-api skill's model docs (2026-10-08): $0.10 / $0.50 per MTok for a prompt of 100K tokens or fewer, cache reads at 0.1x
  // the input rate ($0.01), and "$0.50 / $2.50 when it is longer", so `maxPrompt` makes a longer request `null` rather than priced at the wrong card. Not reproduced against a `cost_usd`.
  // Ahead of `-4-5` by reading order only: the prefixes do not overlap.
  { prefix: "claude-haiku-5-5", input: 0.1, output: 0.5, cacheRead: 0.01, verified: false, maxPrompt: 100_000 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, cacheRead: 0.1, verified: true },
  // The Codex reviewers' model (#4076). OpenAI's model page, "Text tokens": Input $0.2, Cached input $0.02, Output $1.2 per 1M tokens (curl the URL below; the pricing page's Standard table carries the same three).
  // The page adds "Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request" and says nothing of the cached rate there, so a request above 272K is `null`, never a guess.
  // Not checked against an invoice. No Codex request in the 7 days before 2026-10-08 reached 272K (the largest was 159,638).
  { model: "gpt-5.6-luna", input: 0.2, output: 1.2, cacheRead: 0.02, verified: false, source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna.md", fetched: "2026-10-08", maxPrompt: 272_000 },
];

/**
 * Cost of a turn at `prices`, or `null` when the model has no row there: an unpriced turn is unknown, and 0 would say it was free. A Claude row matches by `prefix`, the first that does;
 * any other row by its exact `model`.
 * @param cacheReadRate dollars per million for the cache-read tokens in place of the model's own: how `trace cost` reads a turn the way Claude Code's own display does
 */
export function costAt(prices: readonly PriceRow[], model: string | undefined, tokens: Tokens, cacheReadRate?: number): number | null {
  const price = prices.find((entry) => (entry.model === undefined ? model?.startsWith(entry.prefix ?? "") : model === entry.model));
  if (!price) return null;
  if (price.maxPrompt !== undefined && tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h > price.maxPrompt) return null;
  const dollars = (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * (cacheReadRate ?? price.cacheRead)
    + tokens.cacheWrite5m * price.input * WRITE_5M_FACTOR + tokens.cacheWrite1h * price.input * WRITE_1H_FACTOR) / TOKENS_PER_MILLION;
  return Math.round(dollars * COST_PRECISION) / COST_PRECISION;
}
