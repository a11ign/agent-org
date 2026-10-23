// no-token: gh -- text only
// module: Claude Code pane fixtures for the tests of the safety-prompt reader and of the pool's decline of it (A11-174)
//
// The dangerous-rm pane is a RECONSTRUCTION around the A11-160 command `rm -f $SC/*.done`, not a capture, as `LIMIT_MENU` in `pane-dialog.test.ts` is. Each negative control is a screen a looser
// reader would decline: the two start dialogs (their No means exit), the folder-trust dialog, a question menu, an idle prompt, a working pane, and a dialog the output has moved past.

export const BOX = (...rows: string[]): string => ["● Bash(…)", "╭────────────────────────────────────────────────────╮", ...rows.map((row) => `│ ${row.padEnd(50)} │`), "╰────────────────────────────────────────────────────╯"].join("\n");

/** The A11-160 prompt, reconstructed: the tool heading, the command and its description, the warning, the question and the choices. */
export const DANGEROUS_RM = BOX("Bash command", "", "  rm -f $SC/*.done", "  Remove the done markers", "", "Dangerous rm operation on possibly-empty variable path", "",
  "Do you want to proceed?", "❯ 1. Yes", "  2. No, and tell Claude what to do differently (esc)");
/** The same prompt with the warning directly above the question and no blank line between them. */
export const DANGEROUS_RM_CLOSE = BOX("Bash command", "", "  rm -f $SC/*.done", "", "Dangerous rm operation on possibly-empty variable path", "Do you want to proceed?", "❯ 1. Yes", "  2. No (esc)");
export const EDIT = BOX("Edit file", "", "  src/app.ts", "", "Do you want to make this edit to app.ts?", "❯ 1. Yes", "  2. Yes, allow all edits during this session (shift+tab)", "  3. No, and tell Claude what to do differently (esc)");
export const IMPORTS = "  Allow external CLAUDE.md file imports?\n\n  This project's CLAUDE.md imports files outside the current working directory.\n\n ❯ 1. Yes, allow external imports\n   2. No, disable external imports";
export const TRUST = " Quick safety check: Is this a project you created or one you trust? (Like your own code, a\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";
export const ASK_USER = BOX("Which database should the migration use?", "", "❯ 1. Postgres", "  2. SQLite (esc)", "  3. Type something else");
export const IDLE = "● The change is in.\n\n╭────────────────────────────────╮\n│ > Try \"fix lint errors\"        │\n╰────────────────────────────────╯\n  ? for shortcuts";
export const WORKING = "Running the suite\n  1. parse passed\n  2. render passed\n\n✻ Working… (12s · esc to interrupt)";
export const MOVED_PAST = `${DANGEROUS_RM}\n\n● Skipped it, as asked.\n\n╭────────────────────────────────╮\n│ >                              │\n╰────────────────────────────────╯`;
