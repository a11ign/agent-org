// @ts-check
// module: the calls a code host has made to the place pull requests live (code host contract 1.29, A11-365) -- a type file, read by the contract, the board's health view and the plugins
//
// IT IMPORTS NOTHING, and is its own file so the code host contract (`code-host.ts`) stays within the public API a module may have.

/**
 * The calls a code host has made to the place pull requests live (contract 1.29). `perMinute` is the calls in the last 60 seconds; `notModified` is how many of `total` a conditional read had answered as unchanged, which cost
 * the host's rate limit nothing; a sweep is the window of calls that share one read of each repository (`currentSweep` is open, `lastSweep` is the one before it, null before there was one).
 */
export type GithubCallCounts = Readonly<{
  since: string;
  total: number;
  perMinute: number;
  notModified: number;
  byKind: Readonly<{ graphql: number; rest: number; cli: number }>;
  currentSweep: Readonly<{ at: string; calls: number }> | null;
  lastSweep: Readonly<{ at: string; calls: number }> | null;
}>;
