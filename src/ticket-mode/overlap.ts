// @ts-check
// module: the files a plan says its work will touch, read from its `## Paths` section -- what the board compares when it decides whether a ticket
// waits for another run in the same repository (`board-view.ts`'s `overlapWait`). PURE, and it imports nothing: ticket mode runs on its own, so this
// reads no checkout and no home directory.
//
// A PATH IS REPOSITORY-PREFIXED, `<repo>:<path>`, where `<repo>` is a `clones` key (the names `order.json` uses) and a path ending in `/` is a
// directory. Two paths overlap only in the same repository, and that check is `board-view.ts`'s, beside the rule that uses it.
//
// ONE SECTION FOR BOTH READERS (A11-125): `pr:open` reads a plan's `## Region` to check a pull request's diff, and the overlap wait reads its `## Paths`.
// A plan names its files once, in `## Paths`, and `pathsAsRegion` gives `pr:open` the same list as a Region. A plan written before that has a fenced
// `## Region` whose prefixed lines are the same list, and `parsePaths` reads those when the plan has no `## Paths`.

/**
 * The repository-prefixed paths a plan's `## Paths` section lists, in order, each once. The section is its bullets, up to the next heading, and a
 * bullet is `` - `<repo>:<path>` `` with anything after it. A line that is no such bullet is nothing. A plan without the section declares none, unless
 * its `## Region` is a fenced block of prefixed paths (a plan written before the Paths section): then those are read, and a bare one is not.
 */
export function parsePaths(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const paths = sectionLines(lines, "Paths");
  return paths === null ? fencedRegionPaths(sectionLines(lines, "Region") ?? []) : bulletPaths(paths);
}

/**
 * The plan's `## Paths` as a `## Region` section: a fenced block with one `<repo>:<path>` per line, for `pr:open` to read where it reads a Region. Null
 * when the plan has no paths, so a Region in the ticket is read as it was. PURE.
 */
export function pathsAsRegion(markdown: string): string | null {
  const paths = bulletPaths(sectionLines(markdown.split(/\r?\n/), "Paths") ?? []);
  return paths.length === 0 ? null : `## Region\n\n\`\`\`\n${paths.join("\n")}\n\`\`\`\n\n## Plan paths, end of the Region\n`;
}

/** The lines under a `## <name>` heading, up to the next heading, or null when the text has no such heading. */
function sectionLines(lines: string[], name: string): string[] | null {
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${name}\\s*$`).test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The `<repo>:<path>` bullets of a section's lines, each once, in order. */
function bulletPaths(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    const match = /^\s*[-*]\s+`([^`:\s]+):([^`\s]+)`(\s.*)?$/.exec(line);
    if (match !== null) addOnce(paths, `${match[1]}:${match[2]}`);
  }
  return paths;
}

/** The `<repo>:<path>` lines inside a section's fenced block, each once, in order: a line with no repository prefix names none. */
function fencedRegionPaths(lines: string[]): string[] {
  const paths: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
    } else if (inFence) {
      const match = /^\s*([^\s:`]+):(\S+)\s*$/.exec(line);
      if (match !== null) addOnce(paths, `${match[1]}:${match[2]}`);
    }
  }
  return paths;
}

function addOnce(paths: string[], path: string): void {
  if (!paths.includes(path)) paths.push(path);
}
