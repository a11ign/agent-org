// A LEAF: it imports nothing from this tool, so any module that starts a `.ts` child can import it.
// ADR 0043 Decision 8: checkout-run code is `.ts`, and the host's Node has no type stripping, so a child that runs a `.ts` file is started as
// `node --import <tsx> <file>.ts`. The loader is named by its ABSOLUTE URL, resolved from this file: a bare `--import tsx` resolves from the child's
// working directory, and a child started in a row's worktree or a project's checkout holds no `tsx`.

/** The `node` arguments that let a child load `.ts`: put them before the script. */
export const TSX_IMPORT: string[] = ["--import", import.meta.resolve("tsx")];
