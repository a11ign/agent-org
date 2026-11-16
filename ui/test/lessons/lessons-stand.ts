// module: a stand-in for an instance's Lessons routes (A11-432) -- the answers the Lessons page reads and the edits it sends -- for this page's checks
//
// THE ANSWER IS THE INSTANCE'S OWN: the real route (`lessonsRoute`) over lessons files in a scratch state folder, so the list, an edit, a delete and every refusal are the backend's, and what the
// page changed is in the files the next brief reads (`briefLessons`). Every other call is the shell's stand-in (`../fixtures.ts`).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Lesson, writeLessons } from "../../../src/ticket-mode/retro/lessons-store.ts";
import { lessonsRoute } from "../../../src/ticket-mode/retro/lessons-route.ts";
import type { Fetch } from "../../src/api/request.ts";
import { HERE, standFetch, type Failure, type Stand } from "../fixtures.ts";

export const CONFIRMED = Date.parse("2026-11-14T06:00:00Z");
export const CHANGESET = "A pull request that changes a published package carries a changeset.";

/** A lesson `id` of `text`, citing `runs`, confirmed at {@link CONFIRMED}. */
export const lessonOf = (id: string, text: string, runs: readonly string[] = ["A11-1@1000", "A11-2@2000", "A11-3@3000"]): Lesson => ({ id, text, runs, since: CONFIRMED, confirmedAt: CONFIRMED });

/** A scratch state folder holding `byRepo`'s lessons: by default agent-org's changeset lesson and one of toolchain's. */
export function lessonsState(byRepo: Readonly<Record<string, readonly Lesson[]>> = { "agent-org": [lessonOf("L1", CHANGESET)], toolchain: [lessonOf("T1", "Run the toolchain's own build before a release.", ["A11-7@7000", "A11-8@8000"])] }): string {
  const stateDir = mkdtempSync(join(tmpdir(), "lessons-page-"));
  for (const [repo, lessons] of Object.entries(byRepo)) writeLessons(stateDir, repo, lessons);
  return stateDir;
}

/** A `fetch` whose `/api/lessons` routes are the real route over `stateDir` with `tickets.lessons` `on`, or `fails`, and whose every other call is the shell's stand-in over `stand`. */
export function lessonsFetch(stateDir: string, { on = true, stand = { connections: [HERE] }, fails }: Readonly<{ on?: boolean; stand?: Stand; fails?: Failure }> = {}): Fetch & Readonly<{ paths: string[] }> {
  const shell = standFetch(stand);
  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const [, path] = /(\/api\/lessons(?:\/[a-z]+)?)$/.exec(url) ?? [];
    if (path === undefined) return shell(input, init);
    shell.paths.push(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const [status, answer] = fails === undefined ? lessonsRoute({ stateDir, on }, method, path, body) ?? [404, { error: `no route ${method} ${path}` }] : [fails.status, { error: fails.error }];
    return new Response(JSON.stringify(answer), { status, headers: { "Content-Type": "application/json" } });
  };
  return Object.assign(serve as Fetch, { paths: shell.paths });
}
