// @ts-check
// module: the board's Lessons routes (A11-432, step 2) -- a person reads each repository's lessons, and edits or deletes one the retro got wrong
//
// `GET /api/lessons` lists every repository's lessons, whether or not `tickets.lessons` is on (`on` says which), so a person can check what the retro wrote before the key is turned on.
// `POST /api/lessons/edit` `{ repo, id, text }` and `POST /api/lessons/delete` `{ repo, id }` change one lesson and answer the list after it. The next brief reads the file again, so it carries
// the edit, or no lesson. A request that names no such lesson, or a text a lesson may not hold, is a 400 with its sentence, and nothing is written.
//
// A FILE THAT CANNOT BE READ IS SAID, NEVER SHOWN AS EMPTY (A11-302): the list names it in `unreadable`, and an edit of it is refused rather than written over it.
import type { Json } from "../local-http.ts";
import { deleteLesson, editLesson, type Lesson, LessonRefusal, readLessons, reposWithLessons } from "./lessons-store.ts";

/** One repository's lessons, or why its file cannot be read. */
export type RepoLessonsView = Readonly<{ repo: string; lessons: readonly Lesson[] }>;

/** What `GET /api/lessons` answers: whether briefs carry lessons now, each repository's lessons, and the files that cannot be read. */
export type LessonsView = Readonly<{ on: boolean; repos: readonly RepoLessonsView[]; unreadable: readonly Readonly<{ repo: string; error: string }>[] }>;

/** What the routes need of the board: its state folder, and whether `tickets.lessons` is on. */
export type LessonsBoard = Readonly<{ stateDir: string; on: boolean }>;

export const LESSONS_PATH = "/api/lessons";
export const LESSON_EDIT_PATH = "/api/lessons/edit";
export const LESSON_DELETE_PATH = "/api/lessons/delete";

/** Every repository's lessons, read now. */
export function lessonsView({ stateDir, on }: LessonsBoard): LessonsView {
  const repos: RepoLessonsView[] = [];
  const unreadable: { repo: string; error: string }[] = [];
  for (const repo of reposWithLessons(stateDir)) {
    try {
      repos.push({ repo, lessons: readLessons(stateDir, repo) });
    } catch (error) {
      unreadable.push({ repo, error: (error as Error).message });
    }
  }
  return { on, repos, unreadable };
}

/** The `field` of a request's body, a string that is not empty, or a refusal naming it. */
function named(body: Json, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw new LessonRefusal(`${field} must name the lesson's ${field === "repo" ? "repository" : field}`);
  return value;
}

/** The Lessons routes, or undefined when the request names none of them. */
export function lessonsRoute(board: LessonsBoard, method: string, path: string, body: Json): [number, unknown] | undefined {
  if (method === "GET" && path === LESSONS_PATH) return [200, lessonsView(board)];
  if (method !== "POST" || (path !== LESSON_EDIT_PATH && path !== LESSON_DELETE_PATH)) return undefined;
  try {
    const repo = named(body, "repo");
    const id = named(body, "id");
    if (path === LESSON_EDIT_PATH) {
      if (typeof body.text !== "string") throw new LessonRefusal("text must be the lesson's new text");
      editLesson(board.stateDir, repo, id, body.text);
    } else {
      deleteLesson(board.stateDir, repo, id);
    }
  } catch (error) {
    if (!(error instanceof LessonRefusal)) throw error;
    return [400, { error: error.message }];
  }
  return [200, lessonsView(board)];
}
