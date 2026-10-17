// @ts-check
// module: the files a plan says its work will touch, read from its `## Paths` section -- what the board compares when it decides whether a ticket
// waits for another run in the same repository (`board-view.ts`'s `overlapWait`). PURE, and it imports nothing: ticket mode runs on its own, so this
// reads no checkout and no home directory.
//
// A PATH IS REPOSITORY-PREFIXED, `<repo>:<path>`, where `<repo>` is a `clones` key (the names `order.json` uses) and a path ending in `/` is a
// directory. Two paths overlap only in the same repository, and that check is `board-view.ts`'s, beside the rule that uses it.

/**
 * The repository-prefixed paths a plan's `## Paths` section lists, in order, each once. The section is its bullets, up to the next heading, and a
 * bullet is `` - `<repo>:<path>` `` with anything after it. A line that is no such bullet is nothing. A plan without the section declares none.
 */
export function parsePaths(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Paths\s*$/.test(line));
  if (start === -1) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const match = /^\s*[-*]\s+`([^`:\s]+):([^`\s]+)`(\s.*)?$/.exec(line);
    const path = match === null ? null : `${match[1]}:${match[2]}`;
    if (path !== null && !paths.includes(path)) paths.push(path);
  }
  return paths;
}
