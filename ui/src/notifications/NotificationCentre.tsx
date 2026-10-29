import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { CloseIcon } from "../new-ticket/icons.tsx";
import { ticketHrefOf } from "../new-ticket/new-ticket-model.ts";
import { ALL_FINISHED } from "../new-ticket/use-writer-runs.ts";
import { BellIcon } from "../shell/icons.tsx";
import { useShell } from "../shell/ShellProvider.tsx";
import {
  agoOf, bellLabelOf, clearLabelOf, countsOf, emptyOf, FILTERS, filtered, notificationsOf, type FiledTicket, type Notification, type NotificationFilter,
} from "./notifications-model.ts";
import { useArrivals } from "./use-arrivals.ts";

/** The time the ages are counted to, read again every half minute while the panel is open. */
const AGE_REFRESH_MS = 30_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A ticket the request filed: its key and a one-line title, linked to the tracker when the board has its address. A ticket the board could not read back shows its key alone. */
function FiledRow({ ticket }: Readonly<{ ticket: FiledTicket }>) {
  const href = ticketHrefOf(ticket);
  const content = (
    <>
      <span className="notification-ticket-key">{ticket.key}</span>
      {ticket.title === undefined ? null : <span className="notification-ticket-title" title={ticket.title}>{ticket.title}</span>}
    </>
  );
  return href === "" ? <div className="notification-ticket">{content}</div> : <a className="notification-ticket" href={href} target="_blank" rel="noreferrer">{content}</a>;
}

type ItemProps = Readonly<{ item: Notification; now: number; busy: boolean; onClear: (id: string) => void }>;

/** One notification: how it ended, who wrote it and when, the request, why it failed, and the tickets it filed. */
function NotificationItem({ item, now, busy, onClear }: ItemProps) {
  const failed = item.outcome === "failed";
  return (
    <li className={`notification${item.fresh ? " notification-new" : ""}`}>
      <div className="notification-head">
        <span className={`notification-dot notification-dot-${item.outcome}`} aria-hidden="true" />
        <strong className={`notification-label notification-label-${item.outcome}`}>{failed ? "Failed" : "Done"}</strong>
        {item.fresh ? <span className="notification-chip">New</span> : null}
        <span className="notification-by">{item.headline}</span>
        <div className="notification-spacer" />
        <span className="notification-when">{agoOf(item.at, now)}</span>
        <button type="button" className="notification-clear" aria-label={clearLabelOf(item, now)} title="Clear" disabled={busy} onClick={() => onClear(item.id)}>
          <CloseIcon />
        </button>
      </div>
      <div className="notification-text">{item.text}</div>
      {item.failure === null ? null : <div className="notification-failure">{item.failure}</div>}
      {item.tickets.length === 0 ? null : (
        <div className="notification-made">
          <div className="notification-made-title">Filed by this request</div>
          {item.tickets.map((ticket) => <FiledRow key={ticket.key} ticket={ticket} />)}
        </div>
      )}
    </li>
  );
}

type PanelProps = Readonly<{
  ref: Ref<HTMLDivElement>; items: readonly Notification[]; busy: boolean; acting: ReadonlySet<string>; refusal: string | null; onClear: (id: string) => void; onClearAll: () => void; onHideRefusal: () => void;
}>;

/** The panel: its title and Clear all, the filters with their counts, and the list, or what to say when there is nothing to list. */
function Panel({ ref, items, busy, acting, refusal, onClear, onClearAll, onHideRefusal }: PanelProps) {
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const now = useNow();
  const counts = countsOf(items);
  const shown = filtered(items, filter);
  const empty = emptyOf(filter, items.length);
  return (
    <div ref={ref} role="dialog" aria-label="Notifications" className="notifications">
      <div className="notifications-head">
        <span className="notifications-title">Notifications</span>
        <div className="notification-spacer" />
        <button type="button" className="notifications-clear-all" disabled={items.length === 0 || busy || acting.has(ALL_FINISHED)} onClick={onClearAll}>Clear all</button>
      </div>
      <div className="notifications-filters">
        <div role="group" aria-label="Filter notifications" className="notifications-tabs">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" className="notifications-tab" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label} <span className="notifications-tab-count">{counts[id]}</span>
            </button>
          ))}
        </div>
      </div>
      {refusal === null ? null : (
        <div role="alert" className="notifications-refusal">
          <span>{refusal}</span>
          <button type="button" className="notifications-refusal-hide" onClick={onHideRefusal}>Hide message</button>
        </div>
      )}
      <ul className="notifications-list">
        {shown.map((item) => <NotificationItem key={item.id} item={item} now={now} busy={busy || acting.has(item.id) || acting.has(ALL_FINISHED)} onClear={onClear} />)}
        {shown.length > 0 ? null : (
          <li className="notifications-empty">
            <div className="notifications-empty-title">{empty.title}</div>
            <div className="notifications-empty-note">{empty.note}</div>
          </li>
        )}
      </ul>
    </div>
  );
}

const isEscape = (event: KeyboardEvent): boolean => event.key === "Escape" && !event.defaultPrevented;
/** A control that takes Escape for itself, as the ticket search does. */
const keepsEscape = (target: EventTarget | null): boolean => target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable]");

/**
 * The bell in the sidebar's head and the panel under it, on every page: the finished new-ticket requests with what each filed or why it failed, cleared one at a time or all at once.
 * A request that finishes while the page is open opens the panel, without taking the focus from where the person is. Escape closes it and puts the focus on the bell. The panel is anchored to the sidebar (`shell.css`).
 */
export function NotificationCentre() {
  const { writers, unreachable } = useShell();
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const openPanel = useCallback(() => setOpen(true), []);
  const fresh = useArrivals(writers.runs, openPanel);
  const items = notificationsOf(writers.runs, fresh);
  // A paused connection, or runs that are the tab's kept copy, wait for the instance's own answer before anything is cleared.
  const paused = unreachable !== null || writers.cached;

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      const inside = event.target instanceof Node && (panel.current?.contains(event.target) === true || bell.current === event.target);
      // Escape closes the panel wherever the focus is, as the panel may have opened by itself: a field keeps its own Escape, and the focus goes back to the bell from the panel.
      if (!isEscape(event) || (!inside && keepsEscape(event.target))) return;
      setOpen(false);
      if (inside) bell.current?.focus();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  return (
    <>
      <button ref={bell} type="button" className="bell" aria-label={bellLabelOf(items.length)} aria-haspopup="dialog" aria-expanded={open} title="Notifications" onClick={() => setOpen(!open)}>
        <BellIcon />
        {items.length === 0 ? null : <span className="bell-badge" aria-hidden="true">{items.length}</span>}
      </button>
      {open ? <Panel ref={panel} items={items} busy={paused} acting={writers.acting} refusal={writers.refusal} onClear={writers.dismiss} onClearAll={writers.dismissFinished} onHideRefusal={writers.dismissRefusal} /> : null}
    </>
  );
}
