import { execFileSync } from "node:child_process";

execFileSync("gh", ["release", "create", "corpus"]);
