// @ts-check
// module: the atomic reviewer's onboard step (A11-161) -- the lines of Codex it needs, each with whether it is done already
//
// MOVED OUT OF `install/onboard.ts` (`codexChecklist`) with its words. ONE STEP, AND IT NEVER PROMPTS: onboard installs and logs in to neither Codex nor its account, so the step says what is
// left, and answers `ok: false` while Codex is missing or logged out. A step that is not ok is said and does not stop onboard (`StepResult`).
import type { OnboardStep, StepResult } from "../../src/plugins/manifest.ts";
import { codexPath, codexStatus } from "./checks.ts";

export const ONBOARD_STEPS: readonly OnboardStep[] = [
  {
    name: "codex",
    explain: "Says what is left of Codex, which the atomic reviewer runs on: installed, and logged in. It installs and logs in to neither, and asks nothing.",
    async run(_settings, deps): Promise<StepResult> {
      const installed = codexPath(deps) !== null;
      const loggedIn = installed && codexStatus(deps) === 0;
      const lines = [
        installed ? "Codex is installed: done" : "install Codex, which the atomic reviewer runs on: `npm install -g @openai/codex`",
        loggedIn ? "Codex is logged in: done" : "log in to Codex: `codex login`, with the account the reviewer should use",
      ];
      return { ok: loggedIn, detail: lines.join("\n") };
    },
  },
];
