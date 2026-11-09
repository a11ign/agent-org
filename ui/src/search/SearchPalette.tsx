import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MINE } from "../tickets/tickets-model.ts";
import { ANYONE, UNASSIGNED, YOU } from "../../../src/ticket-mode/assignee-filter.ts";
import type { QueueView } from "../api/types.ts";
import { useModalFocus } from "../lifecycle/use-modal-focus.ts";
import { ticketsHref, type Page } from "../shell/routes.ts";
import { useShell, type ShellValue } from "../shell/ShellProvider.tsx";
import { browserStorage } from "../shell/storage.ts";
import { SEARCH_MIN_CHARS, useWorkspaceSearch } from "../tickets/use-workspace-search.ts";
import { SearchIcon } from "./SearchIcon.tsx";
import { HANDOFF_EVENT, HANDOFF_TTL_MS, handOver, recentOf, rememberOpened } from "./search-memory.ts";
import { countText, matchesOf, metaOf, noMatchText, partsOf, runHref, SEARCH_HINT, statusOf, withRun, type Match } from "./search-model.ts";

/** How many skeleton rows the palette draws while it searches, and how wide each one's title is, as the board draws them. */
const SKELETON_WIDTHS = ["sk-search-70", "sk-search-55", "sk-search-82", "sk-search-60"] as const;

/** The scope the person is in, as the Tickets page names it: Mine, Anyone, Unassigned, or the person's name. */
function scopeNameOf(shell: ShellValue): string {
  if (shell.scope === YOU) return MINE;
  if (shell.scope === ANYONE) return "Anyone";
  if (shell.scope === UNASSIGNED) return "Unassigned";
  return shell.allTickets.find((ticket) => ticket.assignee?.id === shell.scope)?.assignee?.name ?? "that person's tickets";
}

/** `text` with the stretches that match `query` highlighted. */
function Highlighted({ text, query }: Readonly<{ text: string; query: string }>) {
  return <>{partsOf(text, query).map((part, index) => (part.hit ? <mark key={index} className="search-hit">{part.text}</mark> : <span key={index}>{part.text}</span>))}</>;
}

/** What every row needs of the palette: the words to highlight, the queue its status is read from, and what hovering, Open ticket and View run do. */
type RowContext = Readonly<{ query: string; queue: QueueView | null; onActive: (index: number) => void; onOpen: (match: Match) => void; onRun: (match: Match) => void }>;

/** One match: its status dot, key, title and "project · goal · owner", its status, and Open ticket (for an open ticket) and View run (for a ticket with a run). */
function ResultRow({ match, index, active, context }: Readonly<{ match: Match; index: number; active: boolean; context: RowContext }>) {
  const { query, queue, onActive, onOpen, onRun } = context;
  const status = statusOf(match, queue);
  const meta = metaOf(match.ticket);
  // Only the active row's actions are in the Tab order; on a screen with no hover every row shows them, to be tapped.
  const tabIndex = active ? 0 : -1;
  return (
    <li id={`search-option-${index}`} role="option" aria-selected={active} className="search-row" data-key={match.key} onMouseMove={() => onActive(index)}>
      <span aria-hidden="true" className={`search-dot ${status.tone}`} />
      <div className="search-row-main">
        <div className="search-row-line">
          <span className="search-key"><Highlighted text={match.key} query={query} /></span>
          <span className="search-title"><Highlighted text={match.title} query={query} /></span>
        </div>
        {meta === null ? null : <div className="search-meta"><Highlighted text={meta} query={query} /></div>}
      </div>
      <span className={`search-status ${status.tone}`}>{status.label}</span>
      <div className="search-actions">
        {match.ticket === null ? null : <button type="button" className="search-action" tabIndex={tabIndex} onClick={() => onOpen(match)}>Open ticket</button>}
        {match.run === null ? null : <a className="search-action" href={runHref(match.key)} tabIndex={tabIndex} onClick={() => onRun(match)}>View run</a>}
      </div>
    </li>
  );
}

/** The rows the palette draws while it asks: grey blocks, which do not shimmer for reduced motion (`.sk`). */
function SkeletonRows() {
  return (
    <>
      {SKELETON_WIDTHS.map((width) => (
        <li key={width} aria-hidden="true" className="search-row search-skeleton-row">
          <div className="sk sk-search-dot" />
          <div className="search-skeleton-lines"><div className={`sk sk-search-title ${width}`} /><div className="sk sk-search-meta" /></div>
          <div className="sk sk-search-status" />
        </li>
      ))}
    </>
  );
}

/** What the tracker answered when it could not search, with Retry; or why a ticket could not be opened. */
function Refusal({ title, sentence, onRetry }: Readonly<{ title: string; sentence: string; onRetry?: () => void }>) {
  return (
    <div role="alert" className="search-refusal">
      <div className="search-refusal-text"><strong>{title}</strong> {sentence}</div>
      {onRetry === undefined ? null : <button type="button" className="search-retry" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/** The centred note of an empty result, or of a palette nothing was opened from yet. */
function Note({ title }: Readonly<{ title: string | null }>) {
  return (
    <div className="search-note">
      {title === null ? null : <div className="search-note-title">{title}</div>}
      <div className="search-note-text">{SEARCH_HINT}</div>
    </div>
  );
}

/** The keys the footer names. */
function KeyHints() {
  return (
    <div className="search-foot" aria-hidden="true">
      <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
      <span><kbd>Enter</kbd> open ticket</span>
      <span><kbd>⇧ Enter</kbd> view run</span>
      <span><kbd>Esc</kbd> close</span>
    </div>
  );
}

/** What the palette asks the tracker and shows for the words typed: the matches, or Recently opened while fewer than `SEARCH_MIN_CHARS` are typed. */
function useResults(shell: ShellValue, text: string) {
  // Retry gives the search a client of its own, which asks again for the same words.
  const [attempt, setAttempt] = useState(0);
  const client = useMemo(() => ({ ...shell.client, attempt }), [shell.client, attempt]);
  const search = useWorkspaceSearch(client, text);
  const [kept] = useState(() => recentOf(browserStorage()));
  const query = text.trim();
  const asking = query.length >= SEARCH_MIN_CHARS;
  const queue = shell.queue.data;
  const answered = asking && !search.searching && search.refusal === null;
  const rows = asking ? (answered ? matchesOf({ found: search.results, queue, known: shell.allTickets, text: query }) : []) : kept.matches.map((match) => withRun(match, queue));
  return {
    search, query, asking, rows, recent: !asking, recentUnreadable: asking ? null : kept.unreadable, nothingFound: answered && rows.length === 0, retry: () => setAttempt((count) => count + 1),
  };
}

/** What opening a row does: the ticket is handed to the Tickets page, ticked, and a run's page is loaded. Both are remembered in Recently opened. */
function useOpeners(shell: ShellValue, page: Page, onClose: () => void) {
  const storage = browserStorage();
  // Why the last Open ticket could not hand its ticket over, shown in the palette, which stays open.
  const [refusal, setRefusal] = useState<string | null>(null);
  const openTicket = (match: Match) => {
    if (match.ticket === null) return;
    const refused = handOver(storage, {
      key: match.key, project: match.ticket.project, assignee: match.ticket.assignee ?? null, fromProject: shell.project, fromScope: shell.scope, fromScopeName: scopeNameOf(shell), expires: Date.now() + HANDOFF_TTL_MS,
    });
    if (refused !== null) return setRefusal(`The ticket could not be handed to the Tickets page: ${refused}.`);
    // Recently opened is a convenience: a browser that refuses to keep it still opens the ticket, and the palette says it cannot read the list the next time it opens.
    rememberOpened(storage, match);
    onClose();
    // On Tickets already, the page takes it where it is; from any other page, Tickets is loaded and takes it then.
    if (page === "tickets") globalThis.dispatchEvent(new Event(HANDOFF_EVENT));
    else globalThis.location.assign(ticketsHref);
  };
  const viewRun = (match: Match) => {
    if (match.run === null) return;
    rememberOpened(storage, match);
    globalThis.location.assign(runHref(match.key));
  };
  return { openTicket, viewRun, rememberRun: (match: Match) => rememberOpened(storage, match), refusal };
}

/**
 * The "Search tickets" palette (A11-387): a modal over every page that searches every open ticket in the tracker, whoever holds it and whatever its project, and the runs in the queue.
 * ↑ and ↓ move the active row, Enter opens its ticket on the Tickets page (or views its run when its ticket is not open), Shift+Enter views its run, and Esc closes.
 */
export function SearchPalette({ page, onClose }: Readonly<{ page: Page; onClose: () => void }>) {
  const shell = useShell();
  const { dialog, onKeyDown: trapKey } = useModalFocus(onClose);
  // The palette's keys are its own: an Esc that closes it closes nothing behind it.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    trapKey(event);
  };
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState(0);
  const { search, query, asking, rows, recent, recentUnreadable, nothingFound, retry } = useResults(shell, text);
  const { openTicket, viewRun, rememberRun, refusal } = useOpeners(shell, page, onClose);
  const active = Math.min(chosen, Math.max(rows.length - 1, 0));
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const match = rows[active];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setChosen(event.key === "ArrowDown" ? Math.min(active + 1, rows.length - 1) : Math.max(active - 1, 0));
    } else if (event.key === "Enter" && match !== undefined) {
      event.preventDefault();
      if (event.shiftKey || match.ticket === null) viewRun(match);
      else openTicket(match);
    }
  };
  const searching = asking && search.searching;
  const context: RowContext = { query: recent ? "" : query, queue: shell.queue.data, onActive: setChosen, onOpen: openTicket, onRun: rememberRun };
  const count = countText({ query, searching, refused: search.refusal !== null, count: rows.length, minChars: SEARCH_MIN_CHARS });
  return (
    <div className="search-overlay">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Search tickets" tabIndex={-1} className="search-palette" onKeyDown={onKeyDown}>
        <div className="search-box">
          <SearchIcon />
          <input
            ref={input} type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label="Search tickets" aria-controls="search-results" autoComplete="off" className="search-input"
            placeholder="Search every ticket by key, title, project, goal or person" value={text} {...(rows.length === 0 ? {} : { "aria-activedescendant": `search-option-${active}` })}
            onChange={(event) => { setText(event.target.value); setChosen(0); }} onKeyDown={onKey}
          />
          <button type="button" className="search-close" aria-label="Close search" onClick={onClose}><span className="search-close-key">Esc</span><span className="search-close-word">Close</span></button>
        </div>
        <div className="search-scope">
          <span>Searching every project and everyone's tickets</span>
          <span className="search-spacer" />
          <span role="status">{count}</span>
        </div>
        <div className="search-body">
          {refusal === null ? null : <Refusal title="Not opened." sentence={refusal} />}
          {asking && search.refusal !== null ? <Refusal title="Search did not finish." sentence={search.refusal} onRetry={retry} /> : null}
          {recentUnreadable === null ? null : <div role="status" className="search-recent-unreadable">Recently opened could not be read: {recentUnreadable}.</div>}
          {recent && rows.length > 0 ? <div className="search-heading">Recently opened</div> : null}
          <ul id="search-results" role="listbox" aria-label="Matching tickets" aria-busy={searching} className="search-list">
            {searching ? <SkeletonRows /> : rows.map((match, index) => (
              <ResultRow key={match.key} match={match} index={index} active={index === active} context={context} />
            ))}
          </ul>
          {recent && rows.length === 0 ? <Note title={null} /> : null}
          {nothingFound ? <Note title={noMatchText(query)} /> : null}
        </div>
        <KeyHints />
      </div>
    </div>
  );
}
