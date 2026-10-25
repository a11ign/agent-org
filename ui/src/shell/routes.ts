// module: the routes the shell serves -- their addresses, their labels, and which page a path is
//
// THE ADDRESSES ARE THE TICKET'S: `/tickets`, `/runs`, `/runs/<key>` and `/settings/<models|workers|machine|plugins>`, served from the site's root since A11-202 (they were under `/next`, which now
// redirects here). `ui/test/package.test.ts` holds `BASE` to the Astro config's `base`, so the two cannot drift. Every link is a plain address, as on the boards, so moving between pages is a page load.

/** Where the build is served, as a prefix of every address: empty, the site's root. Astro's `base` is `BASE || "/"`. */
export const BASE = "";

/** The sections of Settings, in the order the boards list them. */
export const SETTINGS_SECTIONS = [
  { id: "models", label: "Models" },
  { id: "workers", label: "Workers" },
  { id: "machine", label: "Machine" },
  { id: "plugins", label: "Plugins" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The page a route shows: Tickets, Runs, one run, or a section of Settings. */
export type Page = "tickets" | "runs" | "run" | SettingsSection;

export const ticketsHref = `${BASE}/tickets`;
export const runsHref = `${BASE}/runs`;
/** The Settings link at the bottom of the sidebar goes to Models, the first section. */
export const settingsHref = `${BASE}/settings/models`;
export const settingsSectionHref = (section: SettingsSection): string => `${BASE}/settings/${section}`;

/** The run a path names, `/runs/<key>`, or null for the runs list. A key is one path segment. */
export function runKeyOf(pathname: string): string | null {
  const [, segment = ""] = /^\/runs\/([^/]+)\/?$/.exec(pathname) ?? [];
  if (segment === "") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The page a path shows, given the section of the site it was served from: the runs page serves `/runs/<key>` too, since a static build cannot list the keys. */
export function pageOf(section: Page, pathname: string): Page {
  return section === "runs" && runKeyOf(pathname) !== null ? "run" : section;
}

/** The document title of each page, as the boards give it. */
export const TITLES: Readonly<Record<Page, string>> = {
  tickets: "Atomaut: Tickets",
  runs: "Atomaut: Runs",
  run: "Atomaut: Run detail",
  models: "Atomaut: Settings, Models",
  workers: "Atomaut: Settings, Workers",
  machine: "Atomaut: Settings, Machine",
  plugins: "Atomaut: Plugins",
};

/** Whether a page is one of Settings' sections, which also mark the Settings link. */
export const isSettingsPage = (page: Page): page is SettingsSection => SETTINGS_SECTIONS.some(({ id }) => id === page);
