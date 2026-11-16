import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { compareWithBaseline, DIFFERENCE_THRESHOLD, differingShare } from "./baselines.ts";

/** A PNG `width` by `height`, grey, with the first `marked` pixels white. */
function png(width: number, height: number, marked = 0): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    const value = index < marked ? 255 : 40;
    image.data.set([value, value, value, 255], index * 4);
  }
  return PNG.sync.write(image);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "baselines-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const LINUX = { platform: "linux", update: false } as const;

describe("the baseline comparison (ADR 0018)", () => {
  it("writes the baseline with UPDATE_CAPTURES on Linux, and then matches it", () => {
    expect(compareWithBaseline("a.png", png(10, 10), { platform: "linux", update: true }, dir)).toEqual({ kind: "written" });
    expect(readFileSync(join(dir, "a.png"))).toEqual(png(10, 10));
    expect(compareWithBaseline("a.png", png(10, 10), LINUX, dir)).toEqual({ kind: "matched", share: 0 });
  });

  it("fails a capture that differs beyond the threshold, naming the share", () => {
    compareWithBaseline("a.png", png(10, 10), { platform: "linux", update: true }, dir);
    expect(() => compareWithBaseline("a.png", png(10, 10, 5), LINUX, dir)).toThrow("a.png differs from its baseline in 5.00% of its pixels, over the 0.5% allowed");
  });

  it("passes a capture within the threshold", () => {
    compareWithBaseline("a.png", png(100, 100), { platform: "linux", update: true }, dir);
    const outcome = compareWithBaseline("a.png", png(100, 100, 20), LINUX, dir);
    expect(outcome).toEqual({ kind: "matched", share: 0.002 });
    expect(0.002).toBeLessThan(DIFFERENCE_THRESHOLD);
  });

  it("fails a capture of another size", () => {
    expect(differingShare(png(10, 10), png(10, 11))).toBe(1);
  });

  it("fails a capture with no baseline, naming the command that makes it", () => {
    expect(() => compareWithBaseline("none.png", png(4, 4), LINUX, dir)).toThrow("run the page checks with UPDATE_CAPTURES=1 on Linux");
  });

  it("is skipped on macOS with a printed note, and writes nothing there even when asked", () => {
    const outcome = compareWithBaseline("a.png", png(10, 10), { platform: "darwin", update: true }, dir);
    expect(outcome).toEqual({ kind: "skipped", note: "a.png: the pixel comparison is skipped on darwin; baselines are made and compared on Linux only (ADR 0018)" });
    expect(() => readFileSync(join(dir, "a.png"))).toThrow();
  });
});
