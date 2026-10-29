// @ts-check
// module: the paths a ticket's Region names, as a queued run claims them (A11-374) -- PURE
//
// A QUEUED RUN WITH NO PLAN CLAIMS WHAT ITS TICKET'S REGION NAMES. The plan's `## Paths` is what the overlap hold reads first, and a run queued without a plan has none; its ticket's `## Region` is the next place its files are named. The tokens are written as the overlap
// hold writes a path, `<repo>:<path>`, with the repository left out (`:<path>`) where the Region names none this machine clones: the hold puts the run's own repository there (`repoOf`), which may not be known when the text is read.
//
// IT DOES NOT IMPORT `region-paths.ts`, which `pr:open` reads the same section with: that module imports `project-config.ts`, which refuses at import when the host names no project, and ticket mode runs on a host that names none (`serve-ticket-only-host.test.ts`).
// The grammar here is the same small one: a heading `Region`, up to the next heading, and the path tokens of `region-paths.ts` (`REGION_PATH_TOKEN`), keyed or bare.

/** The heading of a Region section, at any level. */
const REGION_HEADING = /^#{1,6}\s*Region\s*$/i;

/** Any heading: it ends the section. */
const ANY_HEADING = /^#{1,6}\s/;

/** A Region path token, keyed or bare (`REGION_PATH_TOKEN` in `region-paths.ts`): a `/` somewhere in it, with a whitespace, backtick, quote or paren before it. */
const PATH_TOKEN = /(?:^|[\s`"'(])((?:[a-z0-9][a-z0-9-]*:)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g;

/** A `<key>:` prefix on a token, when what follows it holds a `/` or a `.`. */
const KEY_PREFIX = /^([a-z0-9][a-z0-9-]*):(?=[^:]*[/.])/;

/** The text under the description's `## Region` heading up to the next heading, or "" when it has none. PURE. */
function regionSectionOf(description: string): string {
  const lines = description.split(/\r\n|\r|\n/);
  const start = lines.findIndex((line) => REGION_HEADING.test(line));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => ANY_HEADING.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * The paths of `description`'s Region as `<repo>:<path>`, each once, in order. A token keeps the repository key it is prefixed with when that is a `clones` key; any other token (a bare path, or a key this machine does not clone) takes the run's own
 * repository, which is what `:<path>` says. A description with no Region names none. PURE.
 */
export function regionClaimsOf(description: string, clones: readonly string[]): string[] {
  const claims = [...regionSectionOf(description).matchAll(PATH_TOKEN)].map(([, token]) => {
    const key = KEY_PREFIX.exec(token)?.[1];
    return key === undefined ? `:${token}` : `${clones.includes(key) ? key : ""}:${token.slice(key.length + 1)}`;
  });
  return [...new Set(claims)];
}
