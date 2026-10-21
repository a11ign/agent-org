// @ts-check
// module: the doctor's agent-org plugin seam for a test (A11-158): the built-in catalog and the fakes, no bundled package on disk, no module imported, and no project
//
// `diagnose` takes the registry's catalog, the loader and the messaging state as one seam (`DoctorDeps.agentOrgPlugins`), so a doctor test reads no `plugins/` folder and no
// `project.json`. This is the seam's default for a test: each part can be replaced by the one test that is about it.
import type { DoctorDeps } from "../../install/doctor.ts";
import { loadEnabled } from "../loader.ts";
import { buildCatalog } from "../registry.ts";

/** A checkout with no bundled plugin: the catalog is the built-ins and the fakes. */
const NO_PACKAGES = { directories: () => [], text: () => null, isFile: () => false };

export function fakeAgentOrgPlugins(over: Partial<DoctorDeps["agentOrgPlugins"]> = {}): DoctorDeps["agentOrgPlugins"] {
  return {
    catalog: () => buildCatalog({ files: NO_PACKAGES }),
    load: (providers, catalog, deps) => loadEnabled(providers, catalog, deps),
    messaging: async () => ({ provider: null, why: "this test declares no project" }),
    ...over,
  };
}
