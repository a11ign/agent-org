// @ts-check
// module: the deps a test gives a plugin (A11-159) -- every seam answers nothing, so a test names only the ones it uses
//
// `fetch` refuses, `exec` is a program that cannot start, and every file is unreadable, so a plugin that reaches past what its test injected fails loudly instead of touching the
// network, a program or the disk.
import type { ExecResult, PluginDeps } from "../manifest.ts";
import { corePolicy } from "../policy.ts";

const NO_PROGRAM: ExecResult = { status: null, stdout: "", stderr: "no program is injected" };

/** Plugin deps for a test: `over` replaces any seam. */
export function fakePluginDeps(over: Partial<PluginDeps> = {}): PluginDeps {
  return {
    env: {}, stateDir: "/state", log: () => undefined, pick: "assigned", clones: {}, policy: corePolicy(),
    fetch: () => Promise.reject(new Error("fetch is not injected")),
    exec: () => NO_PROGRAM,
    readFile: (path) => { throw new Error(`ENOENT: ${path}`); },
    mode: () => null,
    ...over,
  };
}
