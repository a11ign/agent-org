// a11ign#5169 (the wiring of #5128): the two calls the gate's conditional reads add, as ARGUMENTS. This file names no `gh` and spawns nothing: the runner is the
// caller's, and `index.test.ts` holds this folder to that. They are here, and not at the call sites in `work-gate/reads.ts`, because that file is baselined by
// `gh-call-ratchet.test.ts` (agent-org#826) and a new call shape goes into the plugin (ADR 0046), never into a file that holds a baseline.

/**
 * One GET of a REST `path`, with its headers and the status line (`-i`), for `parseReply` to read: `gh` exits 1 on a 304, so the status is read from the text.
 * `-H` COMES FIRST on a conditional call because the ledger keeps the first two words of a command (`api -H`), which counts the conditional reads apart.
 */
export function conditionalGetArgs(path: string, etag: string | null): string[] {
  return ["api", ...(etag === null ? [] : ["-H", `If-None-Match: ${etag}`]), "-i", path];
}

/** One pull request's detail, asking the fields `fields` names (the same list the open-PR listing asks, so a view and a list cannot disagree about shape). */
export function pullViewArgs(number: number, fields: string): string[] {
  return ["pr", "view", String(number), "--json", fields];
}
