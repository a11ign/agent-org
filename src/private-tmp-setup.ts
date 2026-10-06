// rstest setupFile: runs in each test file's own worker before the file, and gives that file a private TMPDIR (`private-tmp.ts` says why and what shape)
//
// A SEPARATE FILE FROM `private-tmp.ts` BECAUSE A SETUP FILE'S WORK HAPPENS ON IMPORT, and `private-tmp.test.ts` imports the library: folding this into it
// would make the test's own import re-point its TMPDIR.
//
// `process.cwd()` IS THE PROJECT ROOT HERE, not the config's `root`: the file's directory is named from its path relative to the directory the run was started in,
// which is only a label for the report, so a run started one level up names `packages/agent-org/src/x.test.ts` and is still unambiguous.
import { expect } from "@rstest/core";
import { RUN_ROOT_ENV, enterFileDir } from "./private-tmp.ts";

const { testPath } = expect.getState();
if (!testPath) throw new Error("private-tmp-setup: rstest gave this setup file no test path, so the file cannot be given its own TMPDIR");

await enterFileDir({ runRoot: process.env[RUN_ROOT_ENV], testPath, projectRoot: process.cwd() });
