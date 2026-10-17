// module: the Region's pure reading of one changed file, shared by `pr:open`'s row check and its ticket check (A11-74)
//
// A row's Region and a ticket's Region are read by the same rule, so the rule lives here once: the Region first, then the exempt set, then a
// declared `Outside-Region:` escape. `pr-open.ts` and `ticket-mode/pr-open-ticket.ts` both import it. Nothing here reads a row, a ticket or a
// git tree; the callers hand over every fact.
import { ACCEPTANCE_DIR } from "./acceptance-file.ts";
import { regionCovers, regionCoversIn } from "./region-paths.ts";

/**
 * #2417: WHAT NOBODY CHOOSES, EXEMPT FROM THE REGION, AND NAMED SO THE REFUSAL CAN PRINT IT. A row's Region is the
 * author's declaration of what they will change; these three change without anyone deciding to, so a Region naming
 * them would be padding and a refusal over them a false one. One entry per reason, because an author who is told
 * a path is exempt should be told why: an exemption nobody can argue with is a hole nobody can close.
 * `entry` is spelled as `region-paths.ts`'s `regionCovers` reads it: a trailing `/` is a directory.
 */
export const REGION_EXEMPT = [
  { entry: "pnpm-lock.yaml",
    reason: "the package manager rewrites it whenever a dependency moves, so no author chooses its contents" },
  { entry: "docs/commands.md",
    reason: "generated from the CLIs' own flags and tracked on purpose (#478); `generated-paths.test.ts` names it the "
      + "one tracked generated file" },
  { entry: ACCEPTANCE_DIR,
    reason: "each pull request adds its own acceptance file, named for its branch (ADR 0044), so a Region that listed it would be "
      + "padding and a refusal over it a false one" },
  { entry: ".changeset/",
    reason: "a PR that changes a package carries a changeset, which its row cannot declare before it is written" },
];

/** Any line naming the escape, so one that misses the shape is REPORTED rather than silently not clearing a path. */
const OUTSIDE_REGION_LINE = /^\s*(?:[-*>]\s+)?(?:\*\*|__)?Outside-Region:(?:\*\*|__)?\s*(.*)$/i;
/** `<path> — <reason>`: an EM DASH, and a reason. A hyphen or two is `Closes: none`'s spelling and does not clear. */
const OUTSIDE_REGION_SHAPE = /^`?([^\s`]+)`?\s+—\s+(\S.*)$/;

/**
 * #2417: THE ESCAPE -- every `Outside-Region: <path> — <reason>` line in the body. `malformed` keeps the lines that
 * name the escape and miss its shape (a hyphen, no reason), so the refusal can say why one did not clear.
 * @param {string} body
 * @returns {{ declared: { path: string, reason: string }[], malformed: string[] }}
 */
export function outsideRegionDeclarations(body: string): { declared: { path: string; reason: string; }[]; malformed: string[]; } {
  const declared: { path: string; reason: string; }[] = [];
  const malformed: string[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    const named = OUTSIDE_REGION_LINE.exec(line);
    if (!named) continue;
    const shape = OUTSIDE_REGION_SHAPE.exec(named[1].trim());
    if (shape) declared.push({ path: shape[1], reason: shape[2].trim() });
    else malformed.push(line.trim());
  }
  return { declared, malformed };
}

/**
 * #2417: WHERE ONE CHANGED FILE STANDS AGAINST THE REGION -- the Region first, then the exempt set, then a declared
 * escape, so a path in the Region is never counted as an escape the author did not need to write.
 * #2617: `treeKey` is the declared key of the repository THIS tree is (default the first), so `nvda-worker:src/x.ts` in a Region covers
 * `src/x.ts` of that repository's tree and of no other -- and a bare entry is the first repository's, as it always was.
 * @param {string} file
 * @param {{ region: readonly string[], declared: readonly { path: string }[], treeKey?: string }} against
 * @returns {"inside" | "exempt" | "declared" | "outside"}
 */
export function standingAgainstRegion(file: string, { region, declared, treeKey = "" }: { region: readonly string[]; declared: readonly { path: string; }[]; treeKey?: string; }): "inside" | "exempt" | "declared" | "outside" {
  if (region.some((entry) => regionCoversIn(entry, treeKey, file))) return "inside";
  if (REGION_EXEMPT.some(({ entry }) => regionCovers(entry, file))) return "exempt";
  if (declared.some(({ path }) => regionCovers(path, file))) return "declared";
  return "outside";
}

/**
 * The refusal, whole, so an author never learns the escape or the exempt set from a SECOND refusal.
 * @param {{ rows: string, outside: string[], region: readonly string[], base: string, malformed: string[] }} at
 * @returns {string}
 */
export function regionRefusalText({ rows, outside, region, base, malformed }: { rows: string; outside: string[]; region: readonly string[]; base: string; malformed: string[]; }): string {
  const ignored = malformed.map((line) => `\n  IGNORED, not the declared shape (an em dash and a reason are required): ${line}`);
  return `pr-open: REFUSED -- ${outside.length} path(s) changed outside ${rows}'s Region (the diff read is `
    + `${base}...HEAD; \`git fetch origin\` first if that ref is stale):\n`
    + outside.map((file) => `  ${file}`).join("\n")
    + `\nThe Region it was read against: ${region.length > 0 ? region.join(", ") : "(names no path)"}.`
    + "\nIf the change really belongs in this PR, say so, one line per path, in the PR body (the em dash is required, "
    + "and a hyphen does not clear it):\n  Outside-Region: <path> — <reason>"
    + `${ignored.join("")}\nExempt without a line, because nobody chooses them:\n`
    + REGION_EXEMPT.map(({ entry, reason }) => `  ${entry} -- ${reason}`).join("\n")
    + "\nNothing was sent to GitHub (#2417).";
}

/**
 * The one line a passing check prints, so a green reading is not silence either.
 * @param {{ rows: string, changed: string[], standing: string[], base: string }} at
 * @returns {string}
 */
export function regionPassLine({ rows, changed, standing, base }: { rows: string; changed: string[]; standing: string[]; base: string; }): string {
  const count = (kind: string) => standing.filter((s) => s === kind).length;
  return `REGION: ${changed.length} changed path(s) against ${rows}'s Region (${base}...HEAD): ${count("inside")} inside, `
    + `${count("exempt")} exempt, ${count("declared")} cleared by an Outside-Region line.`;
}
