// @ts-check
// module: the check that a plan names every blocker pull request it was given the findings of, and the words that ask for the missing lines (A11-207, A11-167, ADR 0005)
//
// ONE CHECK, TWO CALLERS. The board's settle step (`pool-settle.ts`) refuses a plan that fails it, and the planner's Stop hook (`hook.ts`) runs the same function before the planner ends, so the planner
// is held to exactly the rule the board applies and can fix a miss in its own session. The list it is checked against is the one the planning brief prints (`findings-given.json` is written from the
// same array), so the brief, the hook and the settle step can never disagree. Texts in, texts out: no file is read here.
import { FINDINGS_HEADING, findingsSection, unnamedIn } from "./plan-stamp.ts";

/** What a plan misses of the pull requests it was given: those it does not name, and whether it has the section at all. */
export type FindingsMiss = Readonly<{ missing: readonly string[]; noSection: boolean }>;

/**
 * What the plan files (the texts of every `.md` file in the plan's folder) miss of `given`, the pull requests whose findings the planner was given, or null when nothing is missing. A plan given none is
 * not asked for the section. The section may be in any one file, and a pull request named in any file counts. PURE.
 */
export function findingsMiss(plans: readonly string[], given: readonly string[]): FindingsMiss | null {
  if (given.length === 0) return null;
  if (!plans.some((plan) => findingsSection(plan) !== null)) return { missing: given, noSection: true };
  const missing = given.filter((url) => plans.every((plan) => unnamedIn(plan, [url]).length > 0));
  return missing.length === 0 ? null : { missing, noSection: false };
}

/**
 * The reason the board refuses a plan that missed pull requests. `retried` are the addresses the one automatic retry named (`findings-retried.json`): when there are any, the reason says that retry was
 * made and the plan still misses them, so the card tells the person the planner was already asked once. PURE.
 */
export function findingsRefusal({ missing, noSection }: FindingsMiss, given: readonly string[], retried: readonly string[] = []): string {
  const why = noSection
    ? `the plan has no "${FINDINGS_HEADING}" section, though it was given what its blockers' pull requests found (${given.join(", ")}): it must say how each applies or why it does not`
    : `the plan's "${FINDINGS_HEADING}" section does not name ${missing.join(", ")}: it must say how each pull request's findings apply or why they do not`;
  return retried.length === 0 ? why : `${why}. One automatic retry was made, naming ${retried.join(", ")}, and the plan still misses ${missing.join(", ")}`;
}

/** The line a bullet of the section is written as, with `url` the address exactly as the check reads it. */
const bullet = (url: string): string => `- ${url}: <how this pull request's findings apply to this ticket, or why they do not>`;

/** The exact form the check accepts, as a fenced block holding one bullet for each of `urls`: the section, its heading, and a line for each pull request. PURE. */
export function lineForm(urls: readonly string[]): string {
  return `\`\`\`markdown\n${FINDINGS_HEADING}\n\n${urls.map(bullet).join("\n")}\n\`\`\``;
}

/**
 * What the Stop hook says to the planner whose plan missed pull requests: each ticket's missing addresses and the form of the line to add, where the plan's folder is, that this is the one automatic retry
 * and that the outcome file is written again last. `misses` are the tickets that missed, each with its plan's folder. PURE.
 */
export function retryAsk(misses: readonly Readonly<{ key: string; planDir: string; missing: readonly string[] }>[], outcome: string): string {
  const where = misses.map(({ key, planDir, missing }) => `${key} (plan in ${planDir}) misses ${missing.join(", ")}`).join("; ");
  const forms = misses.map(({ key, missing }) => `${misses.length === 1 ? "" : `For ${key}:\n`}${lineForm(missing)}`).join("\n\n");
  return `the plan's "${FINDINGS_HEADING}" section is missing a blocker pull request: ${where}. Add one line for each, written exactly as shown (the address as given, then how its findings apply to the ticket or why they do not), under a `
    + `${FINDINGS_HEADING} section before \`## Paths\`, in the plan file in its folder:\n\n${forms}\n\nThen write ${outcome} again as the last thing you do. This is the one automatic retry: a plan that still misses one goes to a person.`;
}

/** The pull requests of each ticket a planning run was given the findings of, as `findings-given.json` holds them: the ticket, the folder its plan files go in, and the addresses. */
export type FindingsGiven = readonly Readonly<{ key: string; planDir: string; urls: readonly string[] }>[];

/** What the hook recorded when it asked for the one automatic retry (`findings-retried.json`): when, and the addresses each ticket was asked for. */
export type FindingsRetried = Readonly<{ at: number; missing: Readonly<Record<string, readonly string[]>> }>;

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The text of `findings-given.json` as a list, or null when it is not one. PURE. */
export function parseFindingsGiven(text: string): FindingsGiven | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const rows = parsed.map((row: { key?: unknown; planDir?: unknown; urls?: unknown } | null) => (typeof row?.key === "string" && typeof row.planDir === "string" && isStrings(row.urls)
      ? { key: row.key, planDir: row.planDir, urls: row.urls } : null));
    return rows.every((row) => row !== null) ? rows : null;
  } catch {
    return null;
  }
}

/** The text of `findings-retried.json` as the addresses each ticket was asked for, or an empty record when it is not one. PURE. */
export function retriedUrls(text: string): Readonly<Record<string, readonly string[]>> {
  try {
    const { missing } = JSON.parse(text) as { missing?: Record<string, unknown> | null };
    return Object.fromEntries(Object.entries(missing ?? {}).filter((pair): pair is [string, string[]] => isStrings(pair[1])));
  } catch {
    return {};
  }
}
