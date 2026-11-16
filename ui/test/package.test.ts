import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import config from "../astro.config.ts";
import { UI_ROOT } from "./site.ts";

const readPackage = (path: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; private?: boolean } =>
  JSON.parse(readFileSync(path, "utf8"));

describe("the Astro config", () => {
  it("builds static files for the site's root, with no adapter and so no server of its own", () => {
    expect(config.output).toBe("static");
    expect(config.base).toBe("/");
    expect(config.adapter).toBeUndefined();
  });

  it("has the React integration", () => {
    const names = (config.integrations ?? []).flat().map((integration) => (integration as { name?: string } | null)?.name);
    expect(names).toContain("@astrojs/react");
  });
});

describe("playwright-core", () => {
  // `onboard` and `doctor` install and check the Chromium build of the root's version (A11-151), and a page check starts that build.
  it("is pinned to the root package's exact version", () => {
    const root = readPackage(`${UI_ROOT}../package.json`).dependencies?.["playwright-core"];
    const ui = readPackage(`${UI_ROOT}package.json`).devDependencies?.["playwright-core"];
    expect(root).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ui).toBe(root);
  });
});

describe("the UI package", () => {
  it("is private, so it is never published", () => {
    expect(readPackage(`${UI_ROOT}package.json`).private).toBe(true);
  });
});

describe("the UI program's tsconfig", () => {
  // The server files the API client's types reach import `typescript`, and the `ui` job installs no root `node_modules` for them to find it in (A11-189).
  it("resolves `typescript` from the UI package's own install, which is where CI has it", () => {
    const { config } = ts.readConfigFile(`${UI_ROOT}tsconfig.json`, ts.sys.readFile);
    const [target] = config.compilerOptions.paths?.typescript ?? [];
    expect(target).toBe("./node_modules/typescript");
    expect(existsSync(`${UI_ROOT}${target}/package.json`)).toBe(true);
  });
});

describe("@astrojs/check", () => {
  // `astro check` reports only "The '@astrojs/check' and 'typescript' packages are required" when it cannot load `@astrojs/check`, whatever the cause (A11-456). The cause there was
  // `@emnapi/runtime` 2.0.0-beta.2, from `@rolldown/binding-wasm32-wasi`, resolved as the peer of `@astrojs/astro2tsx`'s `@napi-rs/wasm-runtime` beside its `@emnapi/core` 1.x:
  // "this.bridge.setLastError is not a function". So the load runs here on its own, in a fresh process, as `astro check` runs it, and its own error is the one reported.
  // THE FIX IS `ui/package.json`'s DEV DEPENDENCY `@emnapi/runtime` ^1.11.3: nothing imports it, but pnpm resolves a peer from the importer's own dependencies first, so the chain gets the 1.x
  // runtime its 1.x core needs. It can go once `@astrojs/astro2tsx` pairs the two itself, or the 2.x runtime leaves the lockfile; this test says whether removing it still loads.
  it("loads, and its process exits cleanly", () => {
    const loaded = spawnSync(process.execPath, ["--input-type=module", "--eval", 'await import("@astrojs/check");'], { cwd: UI_ROOT, encoding: "utf8" });
    // The whole result is compared, so a failure prints the load's own stderr; a warning alone on stderr does not fail it.
    expect({ status: loaded.status, stderr: loaded.stderr }).toMatchObject({ status: 0 });
  });
});
