// @ts-check
// module: a model turn's usage, split as it is priced -- input, output, cache reads and the two cache writes. A LEAF: it imports nothing, so the outcome records of ticket mode (A11-430)
// read usage the same way the trace store does without its row-mode imports. `store.ts` re-exports both names for its own readers.

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

export function tokensOf(usage: any): Tokens {
  const split = usage?.cache_creation;
  const written = usage?.cache_creation_input_tokens ?? 0;
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite5m: split ? (split.ephemeral_5m_input_tokens ?? 0) : 0,
    cacheWrite1h: split ? (split.ephemeral_1h_input_tokens ?? 0) : written,
  };
}
