// @ts-check
// module: the version an `agent-org update` is moving this instance to, while it is moving (A11-217) -- read from the update's own lock and folders, never written
//
// A NORMAL UPDATE LEAVES NO DRAIN RECORD, so nothing else names its target before the restart. `update` holds `<tool>/update.lock` from the build to the restarts (`withUpdateLock`): it spends
// minutes building `versions/<name>.partial`, renames that to `versions/<name>`, swaps `current`, and only then restarts the services. So while the lock names a live process, the target is
// the folder being built, or else the version `current` names once it is not the version this instance runs. Nothing here changes `update.ts` or `update-drain.ts`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { currentVersionName, processAlive } from "../install/tool-install.ts";
import { versionsDir } from "../install/tool-versions.ts";

/** What the rule reads of the tool folder. A test passes its own; {@link toolFolderReads} reads the real one. */
export type UpdateReads = Readonly<{
  /** The process id `update.lock` names, or null when there is no lock. */
  lockHolder: () => number | null;
  /** Whether that process is running. */
  alive: (pid: number) => boolean;
  /** The names of the folders in `versions/` that are being built (they end `.partial`), without the ending. */
  building: () => readonly string[];
  /** The version `current` names, or null when there is no link. */
  current: () => string | null;
}>;

const PARTIAL = ".partial";
/** The staging folder of a UI build's download is `<folder>.ui.partial`, which is no version being built. */
const UI_STAGING = `.ui${PARTIAL}`;

/** Whether a name in `versions/` is a version folder being built: `<name>.partial`. */
const isBuild = (name: string): boolean => name.endsWith(PARTIAL) && !name.endsWith(UI_STAGING);

/**
 * The version an update is moving to: null unless `update.lock` names a live process. Then the folder being built (the newest by name when two are, which only an interrupted earlier build leaves),
 * else the version `current` names when it is not `running`. A lock whose process is gone is an update that died, and says nothing. PURE apart from the reads it is given.
 */
export function nextVersion(running: string | null, reads: UpdateReads): string | null {
  const holder = reads.lockHolder();
  if (holder === null || !reads.alive(holder)) return null;
  const building = reads.building().toSorted().at(-1);
  if (building !== undefined) return building;
  const current = reads.current();
  return current !== null && current !== running ? current : null;
}

/** The lock's process id, or null when the file is absent or does not hold one. */
function lockHolderIn(tool: string): number | null {
  try {
    const holder = Number(readFileSync(join(tool, "update.lock"), "utf8").trim());
    return Number.isInteger(holder) && holder > 0 ? holder : null;
  } catch {
    return null;
  }
}

/** The reads of the tool folder `<agent-org home>/tool`. A folder that is not there (a checkout install) reads as no update. */
export function toolFolderReads(tool: string): UpdateReads {
  const dir = versionsDir(tool);
  return {
    lockHolder: () => lockHolderIn(tool),
    alive: processAlive,
    building: () => (existsSync(dir) ? readdirSync(dir).filter(isBuild).map((name) => name.slice(0, -PARTIAL.length)) : []),
    current: () => currentVersionName(tool),
  };
}
