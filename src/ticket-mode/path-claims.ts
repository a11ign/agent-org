// @ts-check
// module: the check that a plan claims the narrowest paths, the list of paths other tickets hold that its planner is shown, and the words that ask for a narrower claim (A11-212)
//
// ONE CHECK, TWO CALLERS. The board's settle step (`pool-settle.ts`) refuses a plan that fails it, and the planner's Stop hook (`hook.ts`) runs the same function before the planner ends, so the planner is held to
// exactly the rule the board applies and can narrow a claim in its own session (the pattern of `blocker-findings-check.ts`). The list it is checked against is the one the planning brief prints (`claims-given.json`
// is written from the same array), so the brief, the hook and the settle step can never disagree. Texts in, texts out: no file is read here.
//
// A PATH IS REPOSITORY-PREFIXED, `<repo>:<path>`, and a path ending in `/` is a directory (`overlap.ts`). Only a DIRECTORY claim is refused: two tickets that name the same file share it for real, and the board's
// overlap wait sequences them. What the check cannot know is which files a planner will write in a folder, so it names the other ticket's paths and the narrower form to use, and invents no path.
import { SCAFFOLD_DIRS } from "../scaffold-dirs.ts";
import type { Order } from "./batch-order.ts";
import { parsePaths } from "./overlap.ts";
import { stepPathsOf } from "./plan-step-sections.ts";

/**
 * Beside a planning run's outcome file: the paths other queued and running tickets hold, as the brief printed them (A11-212). The board writes it from the same array as the brief, and the stop hook and the settle step check the
 * plan's folder claims against it, so the plan is judged against what the planner was shown. No worker may write it.
 */
export const CLAIMS_GIVEN_FILE = "claims-given.json";
/**
 * Beside a planning run's outcome file: written by the stop hook when it asked the planner, once, to narrow a folder claim (A11-212). Its presence ends the retry, and the settle step reads it to say on the card that the
 * retry was made. The board removes it when it prepares a run. No worker may write it.
 */
export const CLAIMS_RETRIED_FILE = "claims-retried.json";

/** What another ticket holds in the board's queue: its key, why it holds (`queued`, `running` or `open pull request`), and the repository-prefixed paths. */
export type HeldClaim = Readonly<{ key: string; state: string; paths: readonly string[] }>;

/** A directory a plan claims that other tickets also write into, and what each of them holds inside it. */
export type FolderClaimMiss = Readonly<{ folder: string; holders: readonly Readonly<{ key: string; paths: readonly string[] }>[] }>;

/** The repository of a prefixed path, and the path inside it. */
function split(path: string): readonly [string, string] {
  const cut = path.indexOf(":");
  return [path.slice(0, cut), path.slice(cut + 1)];
}

/** Whether a prefixed path counts: it names something, and it is not the scaffolding every ticket writes under a name of its own (the board's overlap wait ignores the same ones). */
const counts = (path: string): boolean => {
  const [, inRepo] = split(path);
  return inRepo !== "" && !SCAFFOLD_DIRS.some((dir) => inRepo.startsWith(dir));
};

const isFolder = (path: string): boolean => path.endsWith("/");

/** Whether `held` is `folder` or lies inside it, in the same repository. */
function within(folder: string, held: string): boolean {
  const [repo, inFolder] = split(folder);
  const [heldRepo, inHeld] = split(held);
  return repo === heldRepo && inHeld.startsWith(inFolder);
}

/**
 * Each directory of `planPaths` that other tickets in `claims` also write into: for every held path that is the directory or lies inside it, in the same repository. A directory nobody else holds anything in is not a
 * miss, nor is a file, nor a directory that another ticket's directory holds. The result lists each directory once, in the plan's order. PURE.
 */
export function folderClaimMisses(planPaths: readonly string[], claims: readonly HeldClaim[]): FolderClaimMiss[] {
  const folders = [...new Set(planPaths.filter((path) => counts(path) && isFolder(path)))];
  return folders.flatMap((folder) => {
    const holders = claims.flatMap(({ key, paths }) => {
      const inside = [...new Set(paths.filter((held) => counts(held) && within(folder, held)))];
      return inside.length === 0 ? [] : [{ key, paths: inside }];
    });
    return holders.length === 0 ? [] : [{ folder, holders }];
  });
}

/** The paths a plan's text claims: every `## Paths` bullet and every step section's bullets, each once. PURE. */
export function planClaimPaths(plan: string): string[] {
  return [...new Set([...parsePaths(plan), ...Object.values(stepPathsOf(plan)).flat()])];
}

const quote = (text: string): string => `\`${text}\``;
const inRepo = (path: string): string => split(path)[1];
const listed = (items: readonly string[]): string => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);

/** The words for one directory: who else writes into it, with their paths, and the narrower forms to claim. */
function missAsk({ folder, holders }: FolderClaimMiss): string {
  const who = holders.map(({ key, paths }) => `${key} (${paths.map((path) => quote(inRepo(path))).join(", ")})`);
  const own = quote(`${inRepo(folder)}<feature>/`);
  return `${quote(folder)} is a folder ${listed(who)} also ${holders.length === 1 ? "writes" : "write"} into. Claim the files this ticket writes there, or a folder of its own such as ${own}, instead.`;
}

/** What the board and the hook say to a planner whose plan claims a folder other tickets write into: each folder, who else writes in it and where, and the narrower forms. PURE. */
export function folderClaimAsk(misses: readonly FolderClaimMiss[]): string {
  return misses.map(missAsk).join(" ");
}

/** The reason the board refuses a plan that claimed such a folder. PURE. */
export function folderClaimRefusal(misses: readonly FolderClaimMiss[]): string {
  return `the plan claims a folder that other queued or running tickets also write into. ${folderClaimAsk(misses)}`;
}

/** The reason the board refuses a plan that still claims such a folder after the stop hook's one automatic retry (`claims-retried.json`) asked the planner to narrow it: it says that retry was made. PURE. */
export function folderClaimRetriedRefusal(misses: readonly FolderClaimMiss[]): string {
  return `${folderClaimRefusal(misses)} One automatic retry was made, asking for narrower paths, and the plan still claims ${listed(misses.map(({ folder }) => quote(folder)))}`;
}

/**
 * The paths other tickets hold, as the planning brief prints them: grouped by repository, one line for each ticket holding something in it, such as
 * `- A11-196 (running): \`agent-org:ui/src/shell/App.tsx\`, …`. A planner told that nothing is held says so. PURE.
 */
export function claimsText(claims: readonly HeldClaim[]): string {
  const held = claims.map(({ key, state, paths }) => ({ key, state, paths: paths.filter(counts) })).filter(({ paths }) => paths.length > 0);
  if (held.length === 0) return "No other queued or running ticket holds a path.";
  const repos = [...new Set(held.flatMap(({ paths }) => paths.map((path) => split(path)[0])))].sort();
  return repos.map((repo) => {
    const lines = held.flatMap(({ key, state, paths }) => {
      const here = paths.filter((path) => split(path)[0] === repo);
      return here.length === 0 ? [] : [`- ${key} (${state}): ${here.map(quote).join(", ")}`];
    });
    return `### ${repo}\n\n${lines.join("\n")}`;
  }).join("\n\n");
}

/** Whether the batch's order sequences `a` and `b` on purpose: one is `after` the other, directly or through the tickets between them. */
function sequenced(order: Order, a: string, b: string): boolean {
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const queue = [from];
    for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
      for (const next of order.get(key)?.after ?? []) {
        if (next === to) return true;
        if (!seen.has(next)) queue.push(next);
        seen.add(next);
      }
    }
    return false;
  };
  return reaches(a, b) || reaches(b, a);
}

/**
 * What the other tickets of a batch hold from `key`'s side, as claims: each sibling's plan paths, unless `order` (the batch's `order.json`, null when there is none yet) sequences it with `key`, since a ticket that
 * waits for another is not run beside it. PURE.
 */
export function siblingClaims(key: string, plans: readonly Readonly<{ key: string; paths: readonly string[] }>[], order: Order | null): HeldClaim[] {
  return plans.filter((plan) => plan.key !== key && plan.paths.length > 0 && !(order !== null && sequenced(order, key, plan.key)))
    .map((plan) => ({ key: plan.key, state: "planned in this batch", paths: plan.paths }));
}

/** The text of `claims-given.json` as a list of held claims, or null when it is not one. PURE. */
export function parseClaimsGiven(text: string): HeldClaim[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
    const rows = parsed.map((row: { key?: unknown; state?: unknown; paths?: unknown } | null) => (typeof row?.key === "string" && typeof row.state === "string" && isStrings(row.paths)
      ? { key: row.key, state: row.state, paths: row.paths } : null));
    return rows.every((row) => row !== null) ? rows : null;
  } catch {
    return null;
  }
}

/** What the stop hook says to a planner whose plan claims folders other tickets write into: each ticket's plan folder and the folders it should narrow, that this is the one automatic retry, and that the outcome file is written again last. */
export function claimsRetryAsk(misses: readonly Readonly<{ key: string; planDir: string; folders: readonly FolderClaimMiss[] }>[], outcome: string): string {
  const where = misses.map(({ key, planDir, folders }) => `${key} (plan in ${planDir}): ${folderClaimAsk(folders)}`).join("\n");
  return `the plan claims a folder that other queued or running tickets also write into:\n${where}\nNarrow each claim in the plan file's \`## Paths\` section (and in its step sections), then write ${outcome} again as the last thing you do. `
    + "This is the one automatic retry: a plan that still claims such a folder goes to a person.";
}
