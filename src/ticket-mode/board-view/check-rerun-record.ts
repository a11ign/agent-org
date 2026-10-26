// @ts-check
// module: what the board records of a rerun of the code's own red checks (A11-300), kept on the check head of the pull request the checks are red on

/** A test or step that failed in a run (`test`), the check it failed in and the run's address: what the flake log records if the rerun of the run passes (A11-300). */
export type FlakeCandidate = Readonly<{ test: string; check: string; run: string }>;

/**
 * What a `rerun` record of the code's own red checks holds (A11-300), as against an infrastructure failure's, which has none: why the board reran them (`for`: the checks were red at a head no one had rerun at, or the worker's reply to a round said the failure
 * is not its change's), when (`at`, epoch milliseconds), what failed (`candidates`), and `passed` once the rerun came out green and the flake log has them.
 */
export type RerunRecord = Readonly<{ for: "code" | "reply"; at: number; candidates: readonly FlakeCandidate[]; passed?: true }>;
