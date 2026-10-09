/**
 * THE `node_modules` A COPY OF THE TOOL IS HANDED, found by where `yaml`, a package the tool imports, actually is (#4272; it was `tsx` until #4389 took the loader out).
 *
 * A test that lays a copy of the tool in a scratch directory gives it a `node_modules` symlink, because `bin.ts` and the programs it spawns resolve their packages
 * beside themselves. `<tool root>/node_modules` is that directory in a checkout, but CI's `gate` lays the tool UNDER a project, whose `node_modules` is further
 * up, so a symlink to the tool root's own would dangle. Walking up from here to the nearest `node_modules` that holds `yaml` is right in both.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function toolNodeModules(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "yaml"))) return join(dir, "node_modules");
    if (dirname(dir) === dir) throw new Error("no node_modules holding yaml above src/packaging: the copy of the tool could not resolve its packages");
  }
}
