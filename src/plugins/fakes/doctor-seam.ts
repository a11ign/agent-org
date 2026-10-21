// @ts-check
// module: the doctor's agent-org plugin seam for a test (A11-158, A11-159): this checkout's catalog, the real loader, and no project
//
// `diagnose` takes the registry's catalog, the loader and the messaging state as one seam (`DoctorDeps.agentOrgPlugins`), so a doctor test reads no `project.json`. The catalog is this
// checkout's own (`plugins/linear` is in it, so a host file that names `linear` reads, and its checks run through the deps the test injects: `exec`, `readFile`, `mode`). This is the
// seam's default for a test: each part can be replaced by the one test that is about it, and `bareCatalog` is a catalog with no bundled package.
import type { DoctorDeps } from "../../install/doctor.ts";
import { loadEnabled } from "../loader.ts";
import { buildCatalog, defaultCatalog } from "../registry.ts";

/** A checkout with no bundled plugin: the catalog is the built-ins and the fakes. */
const NO_PACKAGES = { directories: () => [], text: () => null, isFile: () => false };
export const bareCatalog = () => buildCatalog({ files: NO_PACKAGES });

export function fakeAgentOrgPlugins(over: Partial<DoctorDeps["agentOrgPlugins"]> = {}): DoctorDeps["agentOrgPlugins"] {
  return {
    catalog: defaultCatalog,
    load: (providers, catalog, deps) => loadEnabled(providers, catalog, deps),
    messaging: async () => ({ provider: null, why: "this test declares no project" }),
    ...over,
  };
}
