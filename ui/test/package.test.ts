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
