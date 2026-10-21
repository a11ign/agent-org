// @ts-check
// module: what the board says of a breaking update that is draining (A11-169) -- the banner at the top, and the words on a run's line (PURE)
//
// A BREAKING RELEASE DRAINS: no run starts, the live ones finish, and once the wait ends they are stopped and queued again. The instance reads `update-drain.json` and sends the board `UpdateNote`;
// a non-breaking update never has a note, so it shows nothing here. A run's own version is shown only when it is not the instance's.

/** What the drain record and the queue say, as the board is sent it: the release waited for, when the wait ends (ms), the runs still live, whether the wait has ended, and how many runs it stopped. */
export type UpdateNote = Readonly<{ target: string; deadline: number; finishing: number; forced: boolean; stopped: number }>;

/** The time of day in the viewer's zone, `14:30`. */
export function clockOf(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** A release as the board names it: `v0.280.0` is `v0.280`. Anything that is not a release tag (a `main-<sha>` folder) is named as it is. */
export function shortVersion(version: string): string {
  const release = /^(v\d+\.\d+)\.\d+$/.exec(version);
  return release === null ? version : release[1];
}

/** `count` and its noun: `1 run`, `2 runs`. */
const runCount = (count: number): string => `${count} ${count === 1 ? "run" : "runs"}`;

/**
 * The banner while an update drains, or null: "Updating to v0.280 (breaking): no new runs start; 2 runs finishing; forced at 14:30". Once the wait has ended it says how many runs were stopped
 * and queued again instead. The banner is gone when the record is (the note is null).
 */
export function updateBanner(note: UpdateNote | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const head = `Updating to ${shortVersion(note.target)} (breaking): no new runs start`;
  if (note.forced) return `${head}; ${runCount(note.stopped)} stopped at ${clockOf(note.deadline)} and queued again; applying now`;
  return `${head}; ${note.finishing === 0 ? "no run is live" : `${runCount(note.finishing)} finishing`}; forced at ${clockOf(note.deadline)}`;
}

/** What the board knows of the update when it words a run's lines: the drain, and the version the instance runs. */
export type UpdateView = Readonly<{ note: UpdateNote | null; instanceVersion: string | null }>;

/** The run's version beside the instance's, each as short as tells them apart: `on v0.273 (instance v0.280)`. */
export function versionLine(run: string, instance: string): string {
  const [shortRun, shortInstance] = [shortVersion(run), shortVersion(instance)];
  return shortRun === shortInstance ? `on ${run} (instance ${instance})` : `on ${shortRun} (instance ${shortInstance})`;
}
