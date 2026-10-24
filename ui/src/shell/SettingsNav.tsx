import { AttentionBadge } from "../plugins/AttentionBadge.tsx";
import { SETTINGS_SECTIONS, settingsSectionHref, type Page } from "./routes.ts";

/** The Settings sub-nav of the Settings and Plugins pages: its four sections, the current one marked, and the Plugins link with the number of plugins that need attention. */
export function SettingsNav({ page }: Readonly<{ page: Page }>) {
  return (
    <nav aria-label="Settings sections" className="sidebar-section">
      <div className="section-label">Settings</div>
      {SETTINGS_SECTIONS.map(({ id, label }) => (
        <a key={id} className="sub-nav-link" href={settingsSectionHref(id)} {...(page === id ? { "aria-current": "page" as const } : {})}>
          {label}
          {id === "plugins" ? <AttentionBadge /> : null}
        </a>
      ))}
    </nav>
  );
}
