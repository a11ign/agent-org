import { useMemo, useState } from "react";
import type { Lesson } from "../../../src/ticket-mode/retro/lessons-store.ts";
import type { LessonsView } from "../../../src/ticket-mode/retro/lessons-route.ts";
import { usePoll } from "../api/use-poll.ts";
import { EmptyState } from "../lifecycle/EmptyState.tsx";
import { Lifecycle } from "../lifecycle/Lifecycle.tsx";
import { ListSkeleton, SkeletonBlock } from "../lifecycle/Skeleton.tsx";
import { useShell } from "../shell/ShellProvider.tsx";
import { carriedText, countText, dayOf, isEmptyLessons, runLink, ticketOfRun } from "./lessons-model.ts";

/** A person's edit or delete of a lesson, sent to the instance: null once it is taken, or the instance's refusal sentence. */
type Change = Readonly<{ edit: (repo: string, id: string, text: string) => Promise<string | null>; remove: (repo: string, id: string) => Promise<string | null> }>;

/** One lesson: its text and the runs it cites, with Edit and Delete; or, while it is edited, the text box with Save and Cancel; or, once Delete is pressed, the question. */
function LessonItem({ repo, lesson, change }: Readonly<{ repo: string; lesson: Lesson; change: Change }>) {
  const [mode, setMode] = useState<"read" | "edit" | "delete">("read");
  const [text, setText] = useState(lesson.text);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const send = async (sent: Promise<string | null>) => {
    setBusy(true);
    const refused = await sent;
    setBusy(false);
    setRefusal(refused);
    if (refused === null) setMode("read");
  };
  const label = `Lesson text, ${repo}`;
  return (
    <li className="lesson">
      {mode === "edit" ? (
        <textarea className="lesson-input" aria-label={label} rows={3} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
      ) : (
        <p className="lesson-text">{lesson.text}</p>
      )}
      <p className="lesson-meta">
        <span>Confirmed {dayOf(lesson.confirmedAt)}. Runs: </span>
        {lesson.runs.map((run, index) => (
          <span key={run}>
            {index === 0 ? "" : ", "}
            <a className="lesson-run" href={runLink(run)} title={run}>{ticketOfRun(run)}</a>
          </span>
        ))}
      </p>
      <div className="lesson-actions">
        {mode === "read" ? (
          <>
            <button type="button" className="ghost ghost-small" onClick={() => { setText(lesson.text); setRefusal(null); setMode("edit"); }}>Edit</button>
            <button type="button" className="ghost ghost-small" onClick={() => { setRefusal(null); setMode("delete"); }}>Delete</button>
          </>
        ) : mode === "edit" ? (
          <>
            <button type="button" className="ghost ghost-small" disabled={busy} onClick={() => void send(change.edit(repo, lesson.id, text))}>Save</button>
            <button type="button" className="ghost ghost-small" disabled={busy} onClick={() => { setRefusal(null); setMode("read"); }}>Cancel</button>
          </>
        ) : (
          <>
            <span className="lesson-question">Delete this lesson? The next brief carries none.</span>
            <button type="button" className="ghost ghost-small" disabled={busy} onClick={() => void send(change.remove(repo, lesson.id))}>Delete lesson</button>
            <button type="button" className="ghost ghost-small" disabled={busy} onClick={() => setMode("read")}>Keep it</button>
          </>
        )}
      </div>
      {refusal === null ? null : <div role="alert" className="lesson-refused">{refusal}</div>}
    </li>
  );
}

/** Each repository's lessons, the files the instance could not read, and the line on whether briefs carry them. */
function Loaded({ view, change }: Readonly<{ view: LessonsView; change: Change }>) {
  return (
    <div className="lessons">
      <p className="lessons-carried">{carriedText(view)}</p>
      {view.unreadable.map(({ repo, error }) => <div key={repo} role="alert" className="notice notice-danger">{`${repo}'s lessons cannot be read, so none is shown or briefed: ${error}`}</div>)}
      {view.repos.filter(({ lessons }) => lessons.length > 0).map(({ repo, lessons }) => (
        <section key={repo} className="lessons-repo" aria-labelledby={`lessons-${repo}`}>
          <h2 className="lessons-repo-title" id={`lessons-${repo}`}>{repo}</h2>
          <ul className="lessons-list">
            {lessons.map((lesson) => <LessonItem key={lesson.id} repo={repo} lesson={lesson} change={change} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The Lessons page (A11-432): what the daily retro learnt from each repository's runs, from `/api/lessons`, which worker and planner briefs carry while `tickets.lessons` is on. A person edits a lesson
 * the retro worded wrongly, or deletes one that is wrong; the instance's refusal is shown under the lesson, in its own words. A file the instance cannot read is said, never shown as empty.
 */
export function LessonsPage() {
  const { client, connection, connectionsReady } = useShell();
  const read = useMemo(() => client.lessons, [client]);
  const lessons = usePoll(read, { connection, enabled: connectionsReady, isEmpty: isEmptyLessons });
  // A change that is taken reads the lessons again, so the page shows what the next brief carries.
  const taken = (answer: Readonly<{ ok: true } | { ok: false; refusal: string }>): string | null => {
    if (!answer.ok) return answer.refusal;
    lessons.refresh();
    return null;
  };
  const change: Change = {
    edit: async (repo, id, text) => taken(await client.editLesson(repo, id, text)),
    remove: async (repo, id) => taken(await client.deleteLesson(repo, id)),
  };
  return (
    <>
      <div className="page-header lessons-header">
        <div className="page-header-title">
          <h1 className="page-heading">Lessons</h1>
          {lessons.data !== null ? <span className="page-count">{countText(lessons.data)}</span> : lessons.state === "loading" ? <SkeletonBlock shape="count" /> : null}
        </div>
      </div>
      <Lifecycle
        view={lessons}
        skeleton={<ListSkeleton label="Loading lessons" rows={4} />}
        empty={<EmptyState title="No lessons yet" text={`The daily retro writes a repository's lessons once a cause recurs in its runs. ${lessons.data === null ? "" : carriedText(lessons.data)}`} />}
        connection={connection?.name ?? ""}
      >
        {(view) => <Loaded view={view} change={change} />}
      </Lifecycle>
    </>
  );
}
