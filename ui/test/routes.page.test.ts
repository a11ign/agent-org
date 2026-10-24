import { join } from "node:path";
import { locate } from "../../src/ticket-mode/ui-build.ts";
import { requireBuild, UI_ROOT } from "./site.ts";

const DIST = join(UI_ROOT, "dist");

beforeAll(() => requireBuild());

describe("ticket:ui's nearest-page fallback (locate) over the build, for every route", () => {
  it.each([
    ["/tickets", "tickets/index.html"],
    ["/runs", "runs/index.html"],
    ["/settings/models", "settings/models/index.html"],
    ["/settings/workers", "settings/workers/index.html"],
    ["/settings/machine", "settings/machine/index.html"],
    ["/settings/plugins", "settings/plugins/index.html"],
  ])("%s is its own page, %s", (path, file) => {
    expect(locate(DIST, path)?.relative).toBe(file);
  });

  it("answers /runs/<key> with the runs page, since a static build cannot list the keys", () => {
    expect(locate(DIST, "/runs/A11-1")?.relative).toBe("runs/index.html");
  });

  it("sends /next/ and /next/settings on to Tickets and to Models", () => {
    expect(locate(DIST, "/")?.relative).toBe("index.html");
    expect(locate(DIST, "/settings")?.relative).toBe("settings/index.html");
  });

  it("answers an unknown path with the root page, which sends the browser on to Tickets", () => {
    expect(locate(DIST, "/nothing/here")?.relative).toBe("index.html");
  });
});
