// A project script that reaches `gh` ONLY through the script it spawns, as a nightly that runs `npm run corpus:release` does: no import
// edge leads to the spawn, so a walk that knew only imports would call this unit clean (#1974).
import { spawnSync } from "node:child_process";

spawnSync("npm", ["run", "corpus:release"], { stdio: "inherit" });
