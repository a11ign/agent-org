import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overflowProblem, SCREENS } from "./screenshots.ts";
import { requireBuild } from "./site.ts";

describe("the overflow check", () => {
  it("passes a document as wide as the screen", () => {
    expect(overflowProblem({ route: "/", width: 390, scrollWidth: 390, clientWidth: 390 })).toBeNull();
  });

  it("names the route, the width, scrollWidth and clientWidth of a document wider than the screen", () => {
    expect(overflowProblem({ route: "/", width: 390, scrollWidth: 500, clientWidth: 390 })).toBe(
      "/ overflows horizontally at 390px: scrollWidth 500 is wider than clientWidth 390",
    );
  });
});

describe("the screens", () => {
  it("are 1440px and 390px wide", () => {
    expect(SCREENS.map(({ width }) => width)).toEqual([1440, 390]);
  });
});

describe("a page check before the build", () => {
  it("refuses, naming the command that makes the build", () => {
    const empty = mkdtempSync(join(tmpdir(), "ui-no-build-"));
    try {
      expect(() => requireBuild(join(empty, "dist"))).toThrow("run `pnpm ui:build` first");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
