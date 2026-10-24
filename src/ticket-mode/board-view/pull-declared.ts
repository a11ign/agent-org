// @ts-check
// module: the record of what a run's merged pull requests declared of their ticket (A11-181) -- TYPES ONLY
//
// Split from `view-types-and-filters.ts`, which is at the 50 exports a module may have; the page loads this folder as one script, so a name is exported once.

/**
 * What a run's merged pull requests declared of the ticket in their bodies (A11-181): `closes` (a closing line names it), `partial` (a `Partial:` line says what `remains`), or `none` (nothing that overrules the
 * outcome, or a code host that cannot read a body). `urls` are the pull requests whose bodies were read.
 */
export type PullDeclared = Readonly<{ urls: readonly string[] } & ({ kind: "closes" | "none" } | { kind: "partial"; remains: string })>;

/** A merged pull request's declaration that disagreed with the outcome's `partial`: the outcome's own words (null when it had none), the declaration as the board names it, and the pull requests that made it. */
export type PartialOverruled = Readonly<{ outcome: string | null; pull: string; urls: readonly string[] }>;
