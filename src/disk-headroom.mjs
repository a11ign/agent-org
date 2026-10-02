// @ts-check
// FREE BYTES AND FREE INODES ON `/` AND `/tmp`, READ BY THE GATE (#2163).
//
// THE OUTAGE THIS EXISTS FOR, 2026-09-25: `/tmp` ran out of INODES (1,048,576 of 1,048,576) while 73% of its
// BYTES were in use, and every session then failed with `ENOSPC` for about six hours, the chairman the first to
// know. `df -h` reads that machine as healthy, and so does any check that combines the two figures.
//
// SO THE TWO RESOURCES ARE JUDGED SEPARATELY AND NEVER COMBINED. A filesystem is low when EITHER is; nothing
// here averages them, sums them or takes the better of the two. `disk-headroom.test.ts` pins the outage's own
// shape (no free inodes, most of the bytes free) as the case that MUST fire.
//
// THIS FILE READS AND JUDGES; IT NEVER DECIDES WHO IS TOLD. The order to `ceo` is built in `work-gate.mjs`
// beside the other orders, which is where `worker-profile.test.ts` looks for a cause a profile must exist for.
// It imports only `node:*`, so the gate keeps the property its own header states.
import { statfsSync, statSync } from "node:fs";

/**
 * The mounts the org writes to. `/tmp` is a directory on the root filesystem since 2026-09-25 (it was a 16G
 * tmpfs before), so today both name ONE filesystem and it is read once; if `/tmp` is ever a mount of its
 * own again this reads it as its own without a change here.
 */
export const WATCHED_MOUNTS = Object.freeze(["/", "/tmp"]);

/**
 * A resource is LOW below this fraction FREE. It is a FRACTION and not a byte count so that one number serves
 * a 1 TB root disk and a 1M-inode tmpfs alike.
 *
 * WHERE 10% COMES FROM. The outage burned through 1,048,576 inodes. On this host's root filesystem (62.3M
 * inodes, measured 2026-09-25) a 10% floor is 6.2M free inodes, six times what the outage consumed, so a
 * repeat of the same size is announced with room to spare and not at the moment it lands. On bytes it is
 * ~100 GB of the 1 TB disk. It is deliberately not tighter: below 10% a single review clone plus its npm
 * cache (~150M each) is still nowhere near the edge, so a tighter number would only page for a disk that is
 * merely busy. The number is a judgement, and only the SEPARATION of the two resources is taken from the
 * outage.
 */
export const MIN_FREE_FRACTION = 0.10;

/** @typedef {"bytes" | "inodes"} Resource */

/**
 * What one filesystem reported. `inodesTotal` is `null` for a filesystem with NO inode limit.
 * @typedef {{ mounts: string[], bytesFree: number, bytesTotal: number,
 *   inodesFree: number, inodesTotal: number | null }} FilesystemReading
 */

/**
 * @typedef {{ mounts: string[], resource: Resource, free: number, total: number, fraction: number }} LowFinding
 */

/**
 * Read every watched mount ONCE PER FILESYSTEM. Two mounts with the same `st_dev` are one filesystem, and
 * reporting it twice would page twice for one fact.
 *
 * A MOUNT THAT CANNOT BE READ IS NOT A MOUNT THAT IS LOW. It goes in `unreadable` with the reason, and the
 * caller says so; it is never folded into either list by omission.
 *
 * @param {{ mounts?: readonly string[], statfs?: (path: string) => { bsize: number, blocks: number, bavail: number,
 *   files: number, ffree: number }, deviceOf?: (path: string) => number }} [io]
 * @returns {{ readings: FilesystemReading[], unreadable: { mount: string, reason: string }[] }}
 */
export function readFilesystems({ mounts = WATCHED_MOUNTS, statfs = statfsSync,
  deviceOf = (path) => statSync(path).dev } = {}) {
  /** @type {Map<number, FilesystemReading>} */
  const byDevice = new Map();
  /** @type {{ mount: string, reason: string }[]} */
  const unreadable = [];
  for (const mount of mounts) {
    try {
      const device = deviceOf(mount);
      const known = byDevice.get(device);
      if (known) {
        known.mounts.push(mount);
        continue;
      }
      const s = statfs(mount);
      byDevice.set(device, { mounts: [mount], bytesFree: s.bavail * s.bsize, bytesTotal: s.blocks * s.bsize,
        inodesFree: s.ffree, inodesTotal: s.files === 0 ? null : s.files });
    } catch (err) {
      unreadable.push({ mount, reason: String(/** @type {any} */ (err)?.message ?? err).split("\n")[0] });
    }
  }
  return { readings: [...byDevice.values()], unreadable };
}

/**
 * The resources of one filesystem that are below `minFraction` free -- each named, none combined.
 *
 * A filesystem REPORTING ZERO TOTAL INODES has no inode limit (some do), and is not one with none free; read
 * naively that is a permanent false alarm, so `inodesTotal: null` is never low. The same goes for zero
 * total bytes. A figure that is not a finite number is unknowable, so it is not low either -- the caller's
 * `unreadable` is where a failed read is said, and a NaN must not page on a comparison JavaScript lets it fail.
 *
 * The comparison is strict: exactly `minFraction` free is not low.
 *
 * @param {FilesystemReading} reading @param {number} [minFraction]
 * @returns {LowFinding[]}
 */
export function lowResources(reading, minFraction = MIN_FREE_FRACTION) {
  /** @type {LowFinding[]} */
  const found = [];
  for (const [resource, free, total] of /** @type {[Resource, number, number | null][]} */ ([
    ["bytes", reading.bytesFree, reading.bytesTotal],
    ["inodes", reading.inodesFree, reading.inodesTotal]])) {
    if (total === null || !Number.isFinite(free) || !Number.isFinite(total) || total <= 0) continue;
    const fraction = free / total;
    if (fraction < minFraction) found.push({ mounts: reading.mounts, resource, free, total, fraction });
  }
  return found;
}

/**
 * Every low resource on every watched filesystem, plus the mounts that could not be read.
 * @param {Parameters<typeof readFilesystems>[0]} [io] @param {number} [minFraction]
 * @returns {{ low: LowFinding[], unreadable: { mount: string, reason: string }[] }}
 */
export function diskHeadroom(io, minFraction = MIN_FREE_FRACTION) {
  const { readings, unreadable } = readFilesystems(io);
  return { low: readings.flatMap((r) => lowResources(r, minFraction)), unreadable };
}
