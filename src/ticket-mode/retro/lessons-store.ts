// @ts-check
// module: the per-repository lessons the ticket-mode retro writes (A11-432) -- what was learnt across runs, each lesson citing the runs it came from
//
// ONE FILE PER REPOSITORY, `<stateDir>/tickets/lessons/<repo>.json`: lessons are never shared across repositories. A file holds at most {@link LESSONS_MAX} lessons, and each cites the runs
// (`<key>@<ms>`, the outcome record's `run`) it was drawn from, so a person can check it against them.
//
// A LESSON LIVES WHILE IT IS RE-CONFIRMED: each retro that finds it again in new runs moves its `confirmedAt` to now and adds those runs. One nobody re-confirms for {@link LESSON_TTL_MS} is
// dropped by the next retro ({@link mergeLessons}), whether or not that retro read anything for its repository.
//
// AN UNREADABLE FILE IS AN ERROR, NOT EMPTY (A11-358): the retro would otherwise overwrite a person's lessons with none. A file that does not exist yet holds no lessons.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The most lessons one repository's file keeps: the most recently confirmed. */
export const LESSONS_MAX = 15;

/** How long a lesson lives with no retro re-confirming it: 30 days. */
export const LESSON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The most runs one lesson cites: its newest. */
export const LESSON_RUNS_MAX = 10;

/** One lesson: its id, its one-line text, the runs it cites, when it was first written and when a retro last found it again. */
export type Lesson = Readonly<{ id: string; text: string; runs: readonly string[]; since: number; confirmedAt: number }>;

/** A repository's lessons file. */
export type LessonsFile = Readonly<{ v: 1; repo: string; lessons: readonly Lesson[] }>;

/** What one retro proposes for a repository: a lesson it found again (`id` names an existing one), or a new one (no `id`), with the runs it read it in. */
export type Proposal = Readonly<{ id?: string; text: string; runs: readonly string[] }>;

/** The folder of every repository's lessons. */
export const lessonsDir = (stateDir: string): string => join(stateDir, "tickets", "lessons");

/** The lessons file of `repo`: its name kept readable, and a `/` (an `owner/name`) made safe for one file name. */
export const lessonsPath = (stateDir: string, repo: string): string => join(lessonsDir(stateDir), `${encodeURIComponent(repo)}.json`);

/** `repo`'s lessons, or none when it has no file yet. Throws naming the file when it is not a lessons file. */
export function readLessons(stateDir: string, repo: string): readonly Lesson[] {
  const path = lessonsPath(stateDir, repo);
  if (!existsSync(path)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not JSON: ${(error as Error).message}`);
  }
  if (!isLessonsFile(value)) throw new Error(`${path} is not a lessons file`);
  return value.lessons;
}

/** Write `repo`'s lessons, whole, through a temporary file, so a reader never sees half of one. */
export function writeLessons(stateDir: string, repo: string, lessons: readonly Lesson[]): void {
  mkdirSync(lessonsDir(stateDir), { recursive: true });
  const path = lessonsPath(stateDir, repo);
  const file: LessonsFile = { v: 1, repo, lessons };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/**
 * The lessons after a retro at `now`: each proposal that names an existing lesson re-confirms it (its text is kept, since a person may have edited it, and its runs gain the new ones); each that
 * names none is a new lesson with id `newId(n)`; then every lesson not confirmed within {@link LESSON_TTL_MS} is dropped, and of the rest the {@link LESSONS_MAX} most recently confirmed are
 * kept, the one citing more runs winning a tie. PURE.
 */
export function mergeLessons(existing: readonly Lesson[], proposals: readonly Proposal[], now: number, newId: (n: number) => string): Lesson[] {
  const byId = new Map(existing.map((lesson) => [lesson.id, lesson]));
  const added: Lesson[] = [];
  for (const proposal of proposals) {
    const found = proposal.id === undefined ? undefined : byId.get(proposal.id);
    if (found === undefined) added.push({ id: newId(added.length), text: proposal.text, runs: newestRuns(proposal.runs), since: now, confirmedAt: now });
    else byId.set(found.id, { ...found, runs: newestRuns([...found.runs, ...proposal.runs]), confirmedAt: now });
  }
  return [...byId.values(), ...added]
    .filter((lesson) => now - lesson.confirmedAt < LESSON_TTL_MS)
    .sort((a, b) => b.confirmedAt - a.confirmedAt || b.runs.length - a.runs.length)
    .slice(0, LESSONS_MAX);
}

/** `runs` without repeats, the last {@link LESSON_RUNS_MAX} of them. PURE. */
function newestRuns(runs: readonly string[]): string[] {
  return [...new Set(runs)].slice(-LESSON_RUNS_MAX);
}

function isLesson(value: unknown): value is Lesson {
  if (value === null || typeof value !== "object") return false;
  const lesson = value as Record<string, unknown>;
  return typeof lesson.id === "string" && typeof lesson.text === "string" && Array.isArray(lesson.runs) && lesson.runs.every((run) => typeof run === "string")
    && typeof lesson.since === "number" && typeof lesson.confirmedAt === "number";
}

function isLessonsFile(value: unknown): value is LessonsFile {
  if (value === null || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return file.v === 1 && typeof file.repo === "string" && Array.isArray(file.lessons) && file.lessons.every(isLesson);
}
