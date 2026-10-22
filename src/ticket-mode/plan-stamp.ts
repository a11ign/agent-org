// @ts-check
// module: the stamp the board writes into an attached plan -- which text of the ticket it was planned against (A11-167, ADR 0005)
//
// THE BOARD WRITES THE STAMP, NOT THE PLANNER, so the hash is exact: an agent copying a 64-character hash is not reliable, and the board has the planning run's own read. The stamp is a `## Planned against`
// section just before the plan's `## Paths`, which stays last. It holds the ticket's `updatedAt`, the sha256 of its description, the files attached with the plan, and the description as planned, quoted. The
// stamp lives in the tracker, in the plan file, so any instance can read it and show the old text. A plan with no stamp, such as one a person attached, is never read as stale.
import { descriptionHash } from "./ticket-read.ts";

/** The heading of the stamp's section. */
export const STAMP_HEADING = "## Planned against";
/** The heading of the plan's section on what its ticket's blockers found, and the one the stamp is written before. */
export const FINDINGS_HEADING = "## What the blockers found";
const PATHS_HEADING = /^##\s+Paths\s*$/m;

/** What a plan records of the text it was planned against. `files` are the names of every file attached with the plan, the plan itself included. */
export type PlanStamp = Readonly<{ updatedAt: string | null; hash: string; files: readonly string[]; description: string }>;

const UPDATED = "Ticket updated: ";
const HASH = "Description sha256: ";
const FILES = "Files attached with this plan: ";
const NO_UPDATED = "unknown";

/** A description quoted line by line so no heading in it reads as the plan's own (`parsePaths` would take a `## Paths` heading inside it). PURE. */
const quote = (text: string): string => text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");

/** The text `quote` was made from. PURE. */
const unquote = (lines: readonly string[]): string => lines.map((line) => (line.startsWith("> ") ? line.slice(2) : line.replace(/^>/, ""))).join("\n");

/** The stamp's section, as markdown. PURE. */
export function stampText({ updatedAt, hash, files, description }: PlanStamp): string {
  return `${STAMP_HEADING}

- ${UPDATED}${updatedAt ?? NO_UPDATED}
- ${HASH}${hash}
- ${FILES}${files.map((name) => `\`${name}\``).join(", ")}

<details>
<summary>The description as planned</summary>

${quote(description.replace(/\r\n/g, "\n"))}

</details>
`;
}

/** The plan with its stamp section taken out, so stamping twice leaves one. PURE. */
function withoutStamp(plan: string): string {
  const lines = plan.split("\n");
  const start = lines.findIndex((line) => line.trim() === STAMP_HEADING);
  if (start === -1) return plan;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return [...lines.slice(0, start), ...(end === -1 ? [] : rest.slice(end))].join("\n");
}

/**
 * The plan with `stamp` written into it just before its `## Paths` section, or at the end when it has none. A stamp it already holds is replaced. The planner's own sections are left as they are. PURE.
 */
export function stampedPlan(plan: string, stamp: PlanStamp): string {
  const clean = withoutStamp(plan);
  const paths = PATHS_HEADING.exec(clean);
  const at = paths === null ? clean.length : paths.index;
  const before = clean.slice(0, at).replace(/\s*$/, "");
  const after = clean.slice(at);
  return `${before}${before === "" ? "" : "\n\n"}${stampText(stamp)}${after === "" ? "" : `\n${after}`}`;
}

/** The lines of the stamp's section, or null. */
function stampLines(plan: string): string[] | null {
  const lines = plan.split("\n");
  const start = lines.findIndex((line) => line.trim() === STAMP_HEADING);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The stamp a plan holds, or null for a plan without one. A stamp that does not hold its hash, or whose quoted description does not hash to it, is no stamp: the plan is then never read as stale, the same
 * as one a person attached. PURE.
 */
export function parseStamp(plan: string): PlanStamp | null {
  const section = stampLines(plan);
  if (section === null) return null;
  const field = (label: string): string | undefined => section.find((line) => line.startsWith(`- ${label}`))?.slice(`- ${label}`.length).trim();
  const hash = field(HASH);
  const updated = field(UPDATED);
  if (hash === undefined || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const quoted = section.filter((line) => line.startsWith(">"));
  const description = unquote(quoted);
  if (descriptionHash(description) !== hash) return null;
  const files = [...(field(FILES) ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  return { updatedAt: updated === undefined || updated === NO_UPDATED ? null : updated, hash, files, description };
}

/** The text of a plan's `## What the blockers found` section, or null when it has none: from the heading to the next heading of its own level or above. PURE. */
export function findingsSection(plan: string): string | null {
  const lines = plan.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === FINDINGS_HEADING.toLowerCase());
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** The addresses a plan's `## What the blockers found` section names, each once, with the punctuation of the sentence around it left off. PURE. */
export function urlsNamedIn(plan: string): string[] {
  const urls = (findingsSection(plan) ?? "").match(/https?:\/\/[^\s)>\]`"']+/g) ?? [];
  return [...new Set(urls.map((url) => url.replace(/[.,;:]+$/, "")))];
}

/** The pull requests among `urls` that the plan's `## What the blockers found` section does not name. A plan with no such section names none. PURE. */
export function unnamedIn(plan: string, urls: readonly string[]): string[] {
  const named = urlsNamedIn(plan);
  return urls.filter((url) => !named.includes(url));
}
