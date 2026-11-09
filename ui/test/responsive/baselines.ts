// module: the screenshot baselines of the responsive checks (A11-427, ADR 0018) -- a capture compared pixel by pixel with the PNG committed under `ui/captures/responsive/`
//
// BASELINES ARE MADE AND COMPARED ON LINUX ONLY, in the Chromium build `playwright-core` pins: font anti-aliasing differs on another system even with the bundled fonts, so there the comparison is
// skipped with a printed note, and the overflow and hit-area checks still run. `UPDATE_CAPTURES=1` on Linux writes the baselines from the new captures.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { UI_ROOT } from "../site.ts";

/** Where the baselines are committed. */
export const BASELINE_DIR = join(UI_ROOT, "captures", "responsive");

/** How far a pixel's colour may move before it counts as different: pixelmatch's own threshold, from 0 to 1. Anti-aliasing is left out of the count. */
export const PIXEL_THRESHOLD = 0.1;

/**
 * The share of a capture's pixels that may differ before the capture fails: half a percent. A glyph a system font draws (an arrow, an ellipsis) may differ by a few pixels between two Linux hosts; a
 * control that moves, grows or goes changes far more than this.
 */
export const DIFFERENCE_THRESHOLD = 0.005;

/** Where the comparison runs, and whether it writes the baselines: `process.platform` and `UPDATE_CAPTURES`, given so a check can name them. */
export type Mode = Readonly<{ platform: NodeJS.Platform; update: boolean }>;

export const MODE: Mode = { platform: process.platform, update: process.env.UPDATE_CAPTURES === "1" };

/** What a comparison did: matched the baseline, wrote it, or was skipped off Linux with the note it printed. */
export type Outcome = Readonly<{ kind: "matched"; share: number }> | Readonly<{ kind: "written" }> | Readonly<{ kind: "skipped"; note: string }>;

/** The share of pixels that differ between two PNGs of the same size, or 1 when their sizes differ. */
export function differingShare(baseline: Buffer, capture: Buffer): number {
  const [a, b] = [PNG.sync.read(baseline), PNG.sync.read(capture)];
  if (a.width !== b.width || a.height !== b.height) return 1;
  const differing = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: PIXEL_THRESHOLD });
  return differing / (a.width * a.height);
}

/**
 * Compares `capture` with the baseline `name` in `dir`. Off Linux it is skipped and the note printed; with `update` on Linux the baseline is written. REFUSES, naming the file and the share, a capture
 * that differs by more than `DIFFERENCE_THRESHOLD`, and a capture with no baseline, naming the command that makes it.
 */
export function compareWithBaseline(name: string, capture: Buffer, mode: Mode = MODE, dir: string = BASELINE_DIR): Outcome {
  const file = join(dir, name);
  if (mode.platform !== "linux") {
    const note = `${name}: the pixel comparison is skipped on ${mode.platform}; baselines are made and compared on Linux only (ADR 0018)`;
    console.log(note);
    return { kind: "skipped", note };
  }
  if (mode.update) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, capture);
    return { kind: "written" };
  }
  if (!existsSync(file)) throw new Error(`${file} holds no baseline: run the page checks with UPDATE_CAPTURES=1 on Linux to write it`);
  const share = differingShare(readFileSync(file), capture);
  if (share > DIFFERENCE_THRESHOLD) throw new Error(`${name} differs from its baseline in ${(share * 100).toFixed(2)}% of its pixels, over the ${DIFFERENCE_THRESHOLD * 100}% allowed: look at the change, and run with UPDATE_CAPTURES=1 if it is meant`);
  return { kind: "matched", share };
}
