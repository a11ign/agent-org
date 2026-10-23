// @ts-check
// module: the deps a test gives a plugin (A11-159) -- every seam answers nothing, so a test names only the ones it uses
//
// `fetch` refuses, `exec` is a program that cannot start, `probe` finds nothing answering, and every file is unreadable, so a plugin that reaches past what its test injected fails loudly instead of touching the
// network, a program or the disk.
import type { ExecResult, PluginDeps } from "../manifest.ts";
import { messagingHelpers } from "../../messaging/plugin-helpers.ts";
import { corePolicy } from "../policy.ts";
import { publishingHelpers } from "../publishing-helpers.ts";
import { gateHelpers } from "../reviewing-gate.ts";
import { coreRowsHelpers } from "../code-host-slot.ts";
import "../rows.ts"; // registers the part of row mode that reads nothing of the project, so a test needs no project to build a code host; the part that reads it is `row-mode.ts`'s

const NO_PROGRAM: ExecResult = { status: null, stdout: "", stderr: "no program is injected" };

/** Plugin deps for a test: `over` replaces any seam. */
export function fakePluginDeps(over: Partial<PluginDeps> = {}): PluginDeps {
  return {
    env: {}, stateDir: "/state", log: () => undefined, pick: "assigned", clones: {}, policy: corePolicy(),
    fetch: () => Promise.reject(new Error("fetch is not injected")),
    exec: () => NO_PROGRAM,
    readFile: (path) => { throw new Error(`ENOENT: ${path}`); },
    mode: () => null,
    probe: () => Promise.resolve(null),
    messaging: messagingHelpers(), publishing: publishingHelpers(), reviewing: gateHelpers(), rows: coreRowsHelpers,
    place: () => Promise.resolve({ kind: "no-project" }),
    ...over,
  };
}
