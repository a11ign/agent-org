/**
 * THE `node_modules` A COPY OF THE TOOL IS HANDED, found by where `tsx` actually is (#4272).
 *
 * A test that lays a copy of the tool in a scratch directory gives it a `node_modules` symlink, because `bin.mjs` and the units' `--import tsx` resolve `tsx`
 * beside themselves. `<tool root>/node_modules` is that directory in a checkout, but CI's `gate` lays the tool UNDER a project, whose `node_modules` is further
 * up, so a symlink to the tool root's own would dangle. Walking up from here to the nearest `node_modules` that holds `tsx` is right in both.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function toolNodeModules(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "tsx"))) return join(dir, "node_modules");
    if (dirname(dir) === dir) throw new Error("no node_modules holding tsx above src/packaging: the copy of the tool could not resolve its loader");
  }
}
