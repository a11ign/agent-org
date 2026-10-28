// module: REST reads that cost nothing when nothing changed (A11-365) -- a plain `gh api <path>` GET asked with the ETag it was last given, answered from the body kept with it on a 304
//
// GITHUB DOES NOT CHARGE THE RATE LIMIT FOR A 304, so a read the plugin repeats (the runs of a branch, a pull request's REST detail) is sent with `If-None-Match` and costs nothing while it is unchanged. `gh api` has no flag for it: it takes
// the header with `-H`, prints the status line and headers with `-i`, and EXITS NON-ZERO on a 304, so the status is read from the text it printed (`gh-conditional.ts` in core does the same for the gate's reads).
//
// ONLY A READ THAT IS NOTHING BUT A GET OF A PATH IS CONDITIONAL: a call with `--jq`, `--paginate`, a method or a field, and a GraphQL call, is passed on as it was. The kept ETags are in this process's memory,
// at most `KEPT` of them; a restart asks for the body once and is given the ETag again.
import { GhFailure, type Gh } from "./gh.ts";
import type { CallCounter } from "./call-counter.ts";

/** The status GitHub answers a conditional read with when nothing changed. */
const NOT_MODIFIED = 304;

/** The most ETags kept; the oldest is dropped for a new one. */
const KEPT = 200;

type Kept = Readonly<{ etag: string; body: string }>;

/** Whether `path` is a path to GET: not a flag, and not GraphQL's endpoint. */
const isPath = (path: string | undefined): path is string => path !== undefined && !path.startsWith("-") && path !== "graphql";

/** The arguments a conditional read may carry besides its path: header pairs. */
function plainRead(args: readonly string[]): { headers: string[]; path: string } | null {
  if (args[0] !== "api" || args.length < 2) return null;
  const headers: string[] = [];
  let at = 1;
  while (args[at] === "-H" && args[at + 1] !== undefined) {
    headers.push("-H", args[at + 1]);
    at += 2;
  }
  const path = args[at];
  return at === args.length - 1 && isPath(path) ? { headers, path } : null;
}

/** The status, the ETag and the body of what `gh api -i` printed, or null when it printed no status line. */
export function parseReply(text: string): { status: number; etag: string | null; body: string } | null {
  const split = /\r?\n\r?\n/.exec(text);
  const head = split === null ? text : text.slice(0, split.index);
  const status = /^HTTP\/\S+ (\d{3})/.exec(head)?.[1];
  if (status === undefined) return null;
  const etag = /^etag:\s*(.+?)\s*$/im.exec(head)?.[1] ?? null;
  return { status: Number(status), etag, body: split === null ? "" : text.slice(split.index + split[0].length) };
}

/** `gh`, with the plain GET reads it is given sent with the ETag the last answer carried. `counter` is told of each read GitHub answered with 304. */
export function conditionalReads(gh: Gh, counter?: Pick<CallCounter, "notModified">): Gh {
  const kept = new Map<string, Kept>();
  const keep = (key: string, value: Kept): void => {
    kept.delete(key);
    kept.set(key, value);
    if (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
  };
  return (args) => {
    const read = plainRead(args);
    if (read === null) return gh(args);
    const key = `${read.headers.join(" ")} ${read.path}`;
    const before = kept.get(key);
    let text: string;
    try {
      text = gh(["api", ...read.headers, ...(before === undefined ? [] : ["-H", `If-None-Match: ${before.etag}`]), "-i", read.path]);
    } catch (error) {
      // A 304 is a non-zero exit that printed the status: the body kept is the answer. Any other failure is the failure it was.
      const reply = error instanceof GhFailure ? parseReply(error.stdout) : null;
      if (reply?.status === NOT_MODIFIED && before !== undefined) {
        counter?.notModified();
        return before.body;
      }
      throw error;
    }
    const reply = parseReply(text);
    // A reply that carries no status line is not one this can read: the read is made again as it was written.
    if (reply === null) return gh(args);
    if (reply.etag !== null) keep(key, { etag: reply.etag, body: reply.body });
    return reply.body;
  };
}
