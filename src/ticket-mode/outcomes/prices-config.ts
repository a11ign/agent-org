// @ts-check
// module: the prices the outcome records are priced at (A11-430) -- `tickets.prices` in the host file, or the trace's published table when the file names none
//
// PRICES LIVE IN CONFIG, NOT CODE: a published price changes, and a figure priced at a stale one in code would look measured. The default is the trace's own table (`src/trace/prices.ts`), the
// published prices on the day it was read, so a machine that names no prices still has figures, and every one of them is labelled "at configured prices". A row the file names REPLACES the
// table: the file's rows are the whole table, so a model the file leaves out is unpriced, never priced at a neighbour's rate.

import { PRICES, type PriceRow } from "../../trace/prices.ts";
import { TicketSettingsRefusal } from "../settings-refusal.ts";

/** The key the prices are read from. */
export const PRICES_KEY = "tickets.prices";

/** What every dollar figure the outcome rollups give says it is priced at. */
export const PRICED_AT = "at configured prices";

const RATE_FIELDS = ["input", "output", "cacheRead"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` is a whole number of tokens, 1 or more. */
const isWholeTokens = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/** The trace's published table, as rows of a price table. */
const DEFAULT_PRICES: readonly PriceRow[] = PRICES.map(({ prefix, model, input, output, cacheRead, maxPrompt }) => ({
  ...(prefix === undefined ? {} : { prefix }), ...(model === undefined ? {} : { model }), input, output, cacheRead, ...(maxPrompt === undefined ? {} : { maxPrompt }),
}));

/** One row of `tickets.prices`, checked: one of `prefix` or `model`, and the three rates as dollars per million tokens. REFUSES naming the field. */
function priceRowOf(value: unknown, at: string): PriceRow {
  if (!isObject(value)) throw new TicketSettingsRefusal(at, `must be an object of { prefix or model, input, output, cacheRead }, not ${JSON.stringify(value)}`);
  const { prefix, model, maxPrompt } = value;
  const names = [prefix, model].filter((name) => name !== undefined);
  if (names.length !== 1 || typeof names[0] !== "string" || names[0] === "") {
    throw new TicketSettingsRefusal(at, "must name exactly one of prefix (the start of a Claude model id) or model (any other model's exact name)");
  }
  for (const field of RATE_FIELDS) {
    const rate = value[field];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) throw new TicketSettingsRefusal(`${at}.${field}`, `must be dollars per million tokens, 0 or more, not ${JSON.stringify(rate)}`);
  }
  if (maxPrompt !== undefined && !isWholeTokens(maxPrompt)) {
    throw new TicketSettingsRefusal(`${at}.maxPrompt`, `must be a whole number of tokens, 1 or more, not ${JSON.stringify(maxPrompt)}`);
  }
  return {
    ...(prefix === undefined ? {} : { prefix: prefix as string }), ...(model === undefined ? {} : { model: model as string }),
    input: value.input as number, output: value.output as number, cacheRead: value.cacheRead as number, ...(maxPrompt === undefined ? {} : { maxPrompt }),
  };
}

/** The price table `tickets.prices` names, or the trace's published table when it is absent. REFUSES naming the field when it is not a list of rows. */
export function pricesOf(value: unknown): readonly PriceRow[] {
  if (value === undefined) return DEFAULT_PRICES;
  if (!Array.isArray(value)) throw new TicketSettingsRefusal(PRICES_KEY, `must be a list of { prefix or model, input, output, cacheRead, maxPrompt }, not ${JSON.stringify(value)}`);
  return value.map((row, index) => priceRowOf(row, `${PRICES_KEY}[${index}]`));
}
