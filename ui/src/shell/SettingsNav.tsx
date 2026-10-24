import { SETTINGS_SECTIONS, settingsSectionHref, type Page } from "./routes.ts";

/** The Settings sub-nav of the Settings and Plugins pages: its four sections, the current one marked. (The Plugins "needs attention" badge is the Plugins page's, A11-201.) */
export function SettingsNav({ page }: Readonly<{ page: Page }>) {
  return (
    <nav aria-label="Settings sections" className="sidebar-section">
      <div className="section-label">Settings</div>
      {SETTINGS_SECTIONS.map(({ id, label }) => (
        <a key={id} className="sub-nav-link" href={settingsSectionHref(id)} {...(page === id ? { "aria-current": "page" as const } : {})}>
          {label}
        </a>
      ))}
    </nav>
  );
}
