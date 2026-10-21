// @ts-check
// module: Chromium for `ticket:capture` -- the two builds Playwright installs for `chromium`, whether each starts on this machine, and the commands that install what is missing
//
// WHY BOTH. The full browser and the headless shell are different programs: a headless run starts the shell and a headed one the full browser. The first
// capture on the agents host (A11-146) found only the shell started, because the full browser needs system libraries the shell does not. So each build is
// checked by name, and a machine is ready only when both start.
//
// LINUX LIBRARIES. `ldd` names each shared library a build needs that this machine lacks, as `=> not found`. Installing those needs root (`install-deps`),
// which this module never assumes: onboard runs that command only when it is root or `sudo -n` works, and doctor prints it as the fix. On macOS there is no
// `ldd`, so a build is checked for its binary alone.
//
// NOTHING IS STARTED HERE. The binaries are found on disk, by the revisions `playwright-core` names in its own `browsers.json`, so this module loads no
// browser and imports nothing from `playwright-core`. A test injects the probe.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TOOL_ROOT, type Env } from "./paths.ts";

/** The two builds, by the names `playwright-core`'s `browsers.json` gives them. */
export const BUILDS = ["chromium", "chromium-headless-shell"] as const;
export type Build = (typeof BUILDS)[number];

/** The builds' labels, as doctor names them. */
export const BUILD_LABELS: Readonly<Record<Build, string>> = Object.freeze({ "chromium": "chromium", "chromium-headless-shell": "chromium headless shell" });

/** What is known about one build here: its binary, or null when Playwright installed none, and the shared libraries it lacks. */
export type BuildReport = Readonly<{ build: Build; binary: string | null; missing: readonly string[] }>;

/** Each build's report, and why the check could not run at all (`playwright-core` is not in this checkout), or null when it ran. */
export type ChromiumReport = Readonly<{ builds: readonly BuildReport[]; unchecked: string | null }>;

/** The Playwright CLI this checkout installed, which the commands below run. */
export const PLAYWRIGHT_CLI = join(TOOL_ROOT, "node_modules", "playwright-core", "cli.js");

/** The command that installs both browsers, as the person who runs agent-org: no root. */
export const INSTALL_BROWSERS = `node ${PLAYWRIGHT_CLI} install chromium`;

/** The command that installs the system libraries the browsers need. It runs as root, which the person does, never agent-org. */
export const INSTALL_DEPS = `sudo node ${PLAYWRIGHT_CLI} install-deps chromium`;

/** The file names a browser's binary goes by, on each platform: the full browser's on macOS is inside its app bundle. */
const BINARY_NAMES = ["chrome", "chrome-headless-shell", "Google Chrome for Testing"];

/** How deep the browser's folder is searched for its binary. Playwright's layout is two folders down on Linux, and four inside an app bundle on macOS. */
const SEARCH_DEPTH = 4;

/** The shared libraries `ldd` says a binary lacks: each line that ends `=> not found`, by the library's name. PURE. */
export function missingLibraries(ldd: string): string[] {
  return ldd.split("\n").flatMap((line) => {
    const match = /^\s*(\S+)\s+=>\s+not found/.exec(line);
    return match === null ? [] : [match[1]];
  });
}

/** Whether a build starts: its binary is here and it lacks no library. PURE. */
export const buildStarts = (report: BuildReport): boolean => report.binary !== null && report.missing.length === 0;

/** Whether any build lacks a system library, which only `install-deps` as root can add. PURE. */
export const lacksLibraries = ({ builds }: ChromiumReport): boolean => builds.some((report) => report.missing.length > 0);

/**
 * What is wrong with the builds, one line each, with the command that fixes it. Empty when both start. A build with no binary is fixed by the browser install,
 * and one that lacks libraries by the library install, which the person runs as root. PURE.
 */
export function chromiumProblems({ builds, unchecked }: ChromiumReport): string[] {
  if (unchecked !== null) return [`Chromium cannot be checked: ${unchecked}. Run agent-org update, which installs this checkout's dependencies.`];
  return builds.flatMap((report) => {
    const label = BUILD_LABELS[report.build];
    if (report.binary === null) return [`${label} is not installed: run \`${INSTALL_BROWSERS}\``];
    if (report.missing.length > 0) return [`${label} lacks ${report.missing.join(", ")}: run \`${INSTALL_DEPS}\``];
    return [];
  });
}

/**
 * Asks the machine what it has: each build's binary, and what `ldd` says a binary lacks. The probe is injected, so a test asks nothing of the machine.
 */
export type ChromiumProbe = Readonly<{
  /** The binary of `build`'s folder under `revision`, or null when none is there. */
  binary: (build: Build, revision: string) => string | null;
  /** `ldd`'s output for a binary, or null where there is no `ldd` to ask. */
  ldd: (binary: string) => string | null;
  /** `browsers.json` of the installed `playwright-core`, or null when it is not installed in this checkout. */
  browsersJson: () => string | null;
}>;

/** Each build's report from the probe. PURE over the probe. */
export function checkBuilds(probe: ChromiumProbe): ChromiumReport {
  const json = probe.browsersJson();
  if (json === null) return { builds: [], unchecked: "playwright-core is not installed in this checkout" };
  // A check that cannot finish is unchecked, never passed: a missing `ldd` or a damaged browsers file must not read as a working build.
  try {
    const revisions = browserRevisions(json);
    const builds = BUILDS.map((build): BuildReport => {
      const revision = revisions[build];
      const binary = revision === undefined ? null : probe.binary(build, revision);
      if (binary === null) return { build, binary, missing: [] };
      const ldd = probe.ldd(binary);
      return { build, binary, missing: ldd === null ? [] : missingLibraries(ldd) };
    });
    return { builds, unchecked: null };
  } catch (err) {
    return { builds: [], unchecked: `the check could not finish: ${(err as Error).message}` };
  }
}

/** The revision of each build in a `browsers.json` text, by build name. PURE. */
export function browserRevisions(json: string): Partial<Record<Build, string>> {
  const browsers: { name: string; revision: string }[] = JSON.parse(json).browsers ?? [];
  return Object.fromEntries(browsers.filter(({ name }) => (BUILDS as readonly string[]).includes(name)).map(({ name, revision }) => [name, revision]));
}

/** Where Playwright keeps its browsers: `PLAYWRIGHT_BROWSERS_PATH` when it names a folder, else its default for the platform. PURE. */
export function browsersPath(env: Env, home: string, platform: NodeJS.Platform): string {
  const named = env.PLAYWRIGHT_BROWSERS_PATH;
  if (named !== undefined && named !== "" && named !== "0") return named;
  return platform === "darwin" ? join(home, "Library", "Caches", "ms-playwright") : join(home, ".cache", "ms-playwright");
}

/** The first file named as one of `names` under `dir`, searched `depth` folders down, or null. Reads the disk. */
function findBinary(dir: string, names: readonly string[], depth = SEARCH_DEPTH): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return path;
    if (entry.isDirectory() && depth > 0) {
      const found = findBinary(path, names, depth - 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The real probe: the browsers folder on this machine, and `ldd` on Linux. Nothing is started. */
export function defaultChromiumProbe(env: Env, home: string, platform: NodeJS.Platform): ChromiumProbe {
  const root = browsersPath(env, home, platform);
  return {
    binary: (build, revision) => findBinary(join(root, `${build.replaceAll("-", "_")}-${revision}`), BINARY_NAMES),
    ldd: (binary) => {
      if (platform !== "linux") return null;
      const result = spawnSync("ldd", [binary], { encoding: "utf8" });
      if (result.error !== undefined) throw result.error;
      return `${result.stdout}${result.stderr}`;
    },
    browsersJson: () => {
      const path = join(dirname(PLAYWRIGHT_CLI), "browsers.json");
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
  };
}

/** The check on this machine, for doctor and onboard and for `ticket:capture`, which refuses when a build is missing. */
export function chromiumReport(env: Env = process.env, home: string = homedir(), platform: NodeJS.Platform = process.platform): ChromiumReport {
  return checkBuilds(defaultChromiumProbe(env, home, platform));
}
