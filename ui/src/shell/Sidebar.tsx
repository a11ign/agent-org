import type { ReactNode } from "react";
import { connectionLabel } from "../../../src/ticket-mode/board-view.ts";
import { NotificationCentre } from "../notifications/NotificationCentre.tsx";
import { Mark, RunsIcon, SettingsIcon, TicketsIcon } from "./icons.tsx";
import { isSettingsPage, runsHref, settingsHref, ticketsHref, type Page } from "./routes.ts";
import { loopLine } from "./loop-line.ts";
import { pillOf } from "./shell-model.ts";
import { useShell } from "./ShellProvider.tsx";
import { useLoopHealth } from "./use-loop-health.ts";

/** The instance switcher: every connection by the backend's own label (`connectionLabel`), drawn with one connection as well. Choosing one moves the whole UI to it. */
function InstanceSwitcher() {
  const { connections, connection, switchConnection } = useShell();
  return (
    <label className="switcher">
      <span className="visually-hidden">Instance</span>
      <select value={connection?.name ?? ""} disabled={connections.length === 0} onChange={(event) => switchConnection(event.target.value)}>
        {connections.map((candidate) => (
          <option key={candidate.name} value={candidate.name}>
            {connectionLabel(candidate)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The connection status pill, driven by the queue poll: Unreachable only for an SSH instance its proxy cannot reach, Updating while the page shows the Updating screen, Connected otherwise (see `pillOf`). */
function ConnectionPill() {
  const { queue, update } = useShell();
  const { tone, label } = pillOf(queue.state, update);
  return (
    <div role="status" className={`pill pill-${tone}`}>
      <span className="pill-dot" />
      {label}
    </div>
  );
}

/**
 * The loop line under the pill (A11-282): how long the instance's loop makes a request wait, as its p99, warning from 100 ms, with every reading in its tooltip, and under it the rolling health figures and a warning
 * for each over its limit (A11-363). Readings with nothing to click. Not drawn before the first reading, nor for an instance that gives none. The sidebar draws it once the connections are read, so it reads the instance shown.
 */
function LoopLine() {
  const { connection, fetch } = useShell();
  const line = loopLine(useLoopHealth(connection, fetch));
  if (line === null) return null;
  return (
    <>
      <p className={`loop-line${line.warn ? " loop-line-warn" : ""}`} title={line.title}>
        {line.text}
      </p>
      {line.details.map((detail) => <p key={detail} className="loop-line">{detail}</p>)}
      {line.flags.map((flag) => <p key={flag} className="loop-line loop-line-warn">{flag}</p>)}
    </>
  );
}

type NavLinkProps = Readonly<{ href: string; current: boolean; icon: ReactNode; label: string; trailing?: ReactNode }>;

function NavLink({ href, current, icon, label, trailing }: NavLinkProps) {
  return (
    <a className="nav-link" href={href} {...(current ? { "aria-current": "page" as const } : {})}>
      {icon}
      <span className="nav-link-label">{label}</span>
      {trailing}
    </a>
  );
}

/** Tickets with its count, and Runs with the number of runs running. Both are blank while their read is loading, and the Runs badge is hidden at 0. */
function MainNav({ page }: Readonly<{ page: Page }>) {
  const { ticketCount, runningRuns } = useShell();
  const running = runningRuns === null || runningRuns === 0 ? null : (
    <span className="run-badge">
      <span className="run-badge-dot" />
      {runningRuns}
    </span>
  );
  return (
    <nav aria-label="Main" className="sidebar-section">
      <NavLink href={ticketsHref} current={page === "tickets"} icon={<TicketsIcon />} label="Tickets" trailing={<span className="nav-count">{ticketCount ?? ""}</span>} />
      <NavLink href={runsHref} current={page === "runs" || page === "run"} icon={<RunsIcon />} label="Runs" trailing={running} />
    </nav>
  );
}

/**
 * The sidebar of every main page: the mark, the instance switcher and the connection pill, Tickets and Runs, the page's own middle section (`children`), and Settings at the
 * bottom. This is the boards' DOM order, which is the keyboard's focus order.
 */
export function Sidebar({ page, children }: Readonly<{ page: Page; children?: ReactNode }>) {
  const { connectionsReady } = useShell();
  return (
    <aside aria-label="Atomaut" className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <Mark />
          <span className="brand-name">Atomaut</span>
          <div className="sidebar-spacer" />
          <NotificationCentre />
        </div>
        <InstanceSwitcher />
        <ConnectionPill />
        {connectionsReady ? <LoopLine /> : null}
      </div>
      <MainNav page={page} />
      {children}
      <div className="sidebar-spacer" />
      <NavLink href={settingsHref} current={isSettingsPage(page)} icon={<SettingsIcon />} label="Settings" />
    </aside>
  );
}
