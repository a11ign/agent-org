import { Mark, RunsIcon, SettingsIcon, TicketsIcon } from "./icons.tsx";
import { isSettingsPage, runsHref, settingsHref, ticketsHref, type Page } from "./routes.ts";
import { useShell } from "./ShellProvider.tsx";

/** The number of runs running on the Runs tab, which the phone's tab bar shows: nothing while the queue is read or no run is running. */
function RunningBadge() {
  const { runningRuns } = useShell();
  if (runningRuns === null || runningRuns === 0) return null;
  return <span className="tab-badge">{runningRuns}</span>;
}

/**
 * The start of the top bar at 1024px and below (A11-427): the mark, which goes to Tickets, and the tabs Tickets, Runs and Settings. At 640px and below the wordmark is left out and the tabs are the
 * bottom tab bar, with the number of runs running on Runs. Neither is drawn above 1024px, where the sidebar has the mark and these links (`shell.css`). The top bar's other controls are the sidebar's own
 * bell, instance switcher and Search tickets button, which the same stylesheet sets in the bar's row, so each exists once.
 */
export function TopBarStart({ page }: Readonly<{ page: Page }>) {
  const tabs = [
    { href: ticketsHref, label: "Tickets", icon: <TicketsIcon />, current: page === "tickets", badge: null },
    { href: runsHref, label: "Runs", icon: <RunsIcon />, current: page === "runs" || page === "run", badge: <RunningBadge /> },
    { href: settingsHref, label: "Settings", icon: <SettingsIcon />, current: isSettingsPage(page), badge: null },
  ];
  return (
    <>
      <a className="topbar-brand" href={ticketsHref} aria-label="Atomaut, Tickets">
        <Mark />
        <span className="topbar-wordmark" aria-hidden="true">Atomaut</span>
      </a>
      <nav aria-label="Main" className="tabs">
        {tabs.map(({ href, label, icon, current, badge }) => (
          <a key={label} className="tab" href={href} {...(current ? { "aria-current": "page" as const } : {})}>
            {icon}
            <span className="tab-label">{label}</span>
            {badge}
          </a>
        ))}
      </nav>
    </>
  );
}
