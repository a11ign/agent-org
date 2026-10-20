// module: the directories a ticket writes into under a name of its own, shared by the board and by the Region check (A11-117)
//
// THE ONE PLACE THEY ARE NAMED. The board's overlap guard (`ticket-mode/board-view/pull-status-and-notes.ts`) must not count them, and `pr-open-region.ts`
// exempts them from a pull request's Region, so both read these constants. This file imports nothing: the board is sent to the browser as one script,
// which `ui-server.ts` joins to this file, with the relative imports dropped, so the names must be plain declarations. `acceptance-file.ts` names its
// directory from `ACCEPTANCE_SCAFFOLD`.
export const ACCEPTANCE_SCAFFOLD = ".acceptance/";
export const CHANGESET_SCAFFOLD = ".changeset/";

/** The two scaffolding directories, each a directory prefix: no two tickets write the same file in them (A11-117). */
export const SCAFFOLD_DIRS: readonly string[] = [ACCEPTANCE_SCAFFOLD, CHANGESET_SCAFFOLD];
