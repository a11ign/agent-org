// module: the tick snapshot's conditional probe -- the command and the reading of GitHub's answer (A11-160, step 9; moved from `src/tick-snapshot.ts`)
//
// A probe is one `gh api -i` of a REST path with `If-None-Match` when a tag is held. THE STATUS IS READ OFF THE `-i` HEADER BLOCK, never off the exit code: `gh api` exits 1 on a 304 (it says `gh: HTTP 304`). The tag is
// read without its `W/` prefix, which is what core stores and sends back (measured 2026-10-08 with `gh` 2.100: `If-None-Match: W/"x"` came back 200 and cost a point, the same tag unprefixed came back 304). What the caller
// DECIDES from the reading (a 304 is no change, a 404 or 410 is a repository with no Actions, a 200 with a new tag is a change) stays in core. This file spawns nothing: the program is the `run` it is handed.
import type { ProbeFacts, ProbeReading } from "../../../src/plugins/contracts/code-host-rows-readouts.ts";
import type { AnsweringRun } from "../../../src/plugins/contracts/code-host-rows-facts.ts";

const HTTP_OK = 200;

/** The status and the tag of the `-i` header block of a `gh api` answer. */
export function parseAnswer(stdout: string): Pick<ProbeReading, "status" | "etag"> {
  const status = stdout.match(/^HTTP\/[\d.]+ (\d{3})/m);
  const etag = stdout.match(/^etag: *(?:W\/)?("[^"\r\n]*")/im);
  return { status: status === null ? null : Number(status[1]), etag: etag === null ? null : etag[1] };
}

/**
 * What a 200 body says besides its tag (agent-org#1207): the newest `updated_at` of the items it lists and how many there are. The body is the array of issues, or the `workflow_runs` of an Actions answer.
 * `undefined` when the body is neither, or an item has no readable `updated_at`: nothing is then confirmed, and so nothing is drift.
 */
export function factsOf(stdout: string): ProbeFacts | undefined {
  const split = stdout.match(/\r?\n\r?\n/);
  if (split === null || split.index === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(split.index + split[0].length));
  } catch {
    return undefined;
  }
  const items: unknown = Array.isArray(parsed) ? parsed : (parsed as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(items)) return undefined;
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const item of items) {
    const at: unknown = (item as { updated_at?: unknown } | null)?.updated_at;
    const ms = typeof at === "string" ? Date.parse(at) : NaN;
    if (!Number.isFinite(ms)) return undefined;
    if (ms > newestMs) {
      newestMs = ms;
      newest = at as string;
    }
  }
  return { newest, count: items.length };
}

/**
 * One probe of `path`: conditional if a tag is held. `-i` COMES FIRST, then the condition, then the path. NEVER THROWS: a program that could not start or was cut answers no status. A 200 with a tag also says what its
 * body listed (`facts`); any other answer carries none.
 */
export function probeOf({ path, etag, run }: { path: string; etag: string | undefined; run: AnsweringRun }): ProbeReading {
  const conditional = etag === undefined ? [] : ["-H", `If-None-Match: ${etag}`];
  const { stdout } = run(["api", "-i", ...conditional, path]);
  const answer = parseAnswer(stdout);
  return { ...answer, facts: answer.status === HTTP_OK && answer.etag !== null ? factsOf(stdout) : undefined };
}
