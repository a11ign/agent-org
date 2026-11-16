// @ts-check
// module: the lessons a worker or planner brief carries (A11-432, step 2) -- each repository's lessons file, as the daily retro wrote it and a person left it, read as the run starts
//
// ONLY WHILE `tickets.lessons` IS ON: on by default since the offline eval showed no drop (the plan's step 3), and with it off a brief carries no lessons whatever the files hold. The caller,
// `lessonsFor` in `pool-prepare.ts`, checks the setting; this module only reads and writes the section.
//
// READ AT EACH START, so a person's edit or delete on the board is in the next brief. A file that cannot be read is said and left out: a run is never stopped for want of its lessons.
import { type Lesson, readLessons } from "./lessons-store.ts";

/** One repository's lessons, as a brief names them. */
export type RepoLessons = Readonly<{ repo: string; lessons: readonly Lesson[] }>;

/**
 * The lessons of each of `repos`, in their order and once each, for a run starting now: a repository with no lessons or no file is left out. A file that cannot be read is said through `log`
 * and left out.
 */
export function briefLessons({ stateDir, repos, log }: Readonly<{ stateDir: string; repos: readonly (string | null | undefined)[]; log: (line: string) => void }>): RepoLessons[] {
  const named = [...new Set(repos.filter((repo): repo is string => typeof repo === "string" && repo !== ""))];
  return named.flatMap((repo) => {
    try {
      const lessons = readLessons(stateDir, repo);
      return lessons.length === 0 ? [] : [{ repo, lessons }];
    } catch (error) {
      log(`the lessons of ${repo} are left out of the brief: ${(error as Error).message}`);
      return [];
    }
  });
}

/** One lesson as a brief's bullet: its text, then the runs it cites. PURE. */
const lessonLine = ({ text, runs }: Lesson): string => `- ${text} (runs: ${runs.join(", ")})`;

/**
 * The brief's section of lessons, or nothing when there are none. `reader` names who reads it, "worker" or "planner", for the sentence on what a lesson is worth beside the ticket. PURE.
 */
export function lessonsText(found: readonly RepoLessons[], reader: "worker" | "planner"): string {
  if (found.length === 0) return "";
  const work = reader === "worker" ? "your change" : "your plan";
  return `
## Lessons from earlier runs

The board's daily retro read the recent runs in ${found.length === 1 ? "this repository" : "these repositories"} and found these causes recurring: reviewer findings, red checks, rounds at the cap and runs handed to a person. Each cites the runs (\`<ticket>@<start>\`) it came from, and a person may have edited it. Check ${work} against each one that applies. A lesson is advice, not a decision: where one disagrees with the ticket's Decisions, the plan or the repository's own rules, those win.
${found.map(({ repo, lessons }) => `\n### ${repo}\n\n${lessons.map(lessonLine).join("\n")}\n`).join("")}`;
}
