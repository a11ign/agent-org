// module: the board says a plugin's failing doctor row once, on its own log, when it starts failing, when what it says changes, and when it passes again (A11-274)
//
// THE ROWS ARE DRAWN ON THE PAGE, BUT NOBODY IS TOLD. The `merge flow` row lists every repository that lacks the merge flow, and a person saw it only by opening Settings → Plugins. The board's log is where it tells the
// chairman's session what it found (the plan of A11-274: "one board log line, said only when the missing set changes"), and the board runs the checks behind the page (`plugins-api.ts`), so it says each change
// there once. A plugin's own `deps.log` cannot: the page's checks run in a child process with a silent log.
//
// WHAT WAS SAID IS KEPT IN `<stateDir>/plugin-rows-said.json` (failing rows by `<plugin>/<row>`, with the detail said), so a board that restarts says nothing it has said. A plugin that was not checked in a run keeps
// what was said of it: nothing is known of it then. A record that cannot be read is empty, and one that cannot be written leaves the old, so a change is said again rather than never.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginCheck } from "../plugins/manifest.ts";

/** The file, in the board's state folder, that keeps the failing rows the board has said. */
export const SAID_FILE = "plugin-rows-said.json";

/** The failing rows said, by `<plugin>/<row>`, with the detail said of each. */
export type Said = Readonly<Record<string, string>>;

/** The checks of each plugin run this time, by the plugin's name. */
export type PluginRows = Readonly<Record<string, readonly PluginCheck[]>>;

/** What to say of `rows`, given what was said: a line for each row that fails and was not said with that detail, and one for each row said failing that passes now; and what has been said after it. PURE. */
export function changesOf(said: Said, rows: PluginRows): Readonly<{ lines: readonly string[]; said: Said }> {
  const next: Record<string, string> = Object.fromEntries(Object.entries(said).filter(([key]) => !(key.split("/")[0] in rows)));
  const lines: string[] = [];
  for (const [plugin, checks] of Object.entries(rows)) {
    for (const { name, ok, detail, fix } of checks) {
      const key = `${plugin}/${name}`;
      if (!ok) {
        next[key] = detail;
        if (said[key] !== detail) lines.push(`plugin ${plugin}: ${name} fails: ${detail}${fix === null ? "" : ` (fix: ${fix})`}`);
      } else if (key in said) {
        lines.push(`plugin ${plugin}: ${name} passes now`);
      }
    }
  }
  return { lines, said: next };
}

/** What `<stateDir>/plugin-rows-said.json` holds: empty when it is absent or cannot be read. */
function readSaid(stateDir: string): Said {
  try {
    const recorded: unknown = JSON.parse(readFileSync(join(stateDir, SAID_FILE), "utf8"));
    if (recorded === null || typeof recorded !== "object" || Array.isArray(recorded)) return {};
    return Object.fromEntries(Object.entries(recorded).filter(([, detail]) => typeof detail === "string"));
  } catch {
    return {};
  }
}

/** Says on `log` each change of `rows` since the board last said them, and records what it said, written whole (a temporary file renamed over the record). */
export function sayRowChanges(stateDir: string, rows: PluginRows, log: (line: string) => void): void {
  const { lines, said } = changesOf(readSaid(stateDir), rows);
  if (lines.length === 0) return;
  for (const line of lines) log(line);
  try {
    const scratch = join(stateDir, `${SAID_FILE}.${process.pid}.tmp`);
    writeFileSync(scratch, `${JSON.stringify(said)}\n`);
    renameSync(scratch, join(stateDir, SAID_FILE));
  } catch {
    // Not recorded: the next run says it again.
  }
}
