// @ts-check
// module: the atomic reviewer's onboard steps (A11-161) -- the lines of Codex it needs, each with whether it is done already, and Codex's trust of the host file's repositories (A11-221)
//
// MOVED OUT OF `install/onboard.ts` (`codexChecklist`) with its words. NO STEP PROMPTS: onboard installs and logs in to neither Codex nor its account, so the `codex` step says what is left, and
// answers `ok: false` while Codex is missing or logged out. The `codex trust` step adds the trust entries the host file's repositories lack. A step that is not ok is said and does not stop onboard (`StepResult`).
import type { OnboardStep, StepResult } from "../../src/plugins/manifest.ts";
import { codexPath, codexStatus } from "./checks.ts";
import { ensureTrusted, hostRepositories, type Ensured } from "./codex-trust.ts";

/** What onboard says of one repository it asked Codex to trust. */
function trustLine(root: string, answer: Ensured): string {
  switch (answer.kind) {
    case "added": return `Codex trusts ${root}: trusted now`;
    case "present": return answer.level === "trusted" ? `Codex trusts ${root}: done` : `Codex trusts ${root}: left as set (${answer.level})`;
    case "not-host": return `Codex was not told to trust ${root}: ${answer.reason}`;
    case "refused": return `Codex could not be told to trust ${root}: ${answer.reason}`;
  }
}

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
  {
    name: "codex trust",
    explain: "Makes Codex trust every repository the host file names, so a review there does not stop on Codex's \"Trust this folder?\" dialog. It adds the entries that are missing, leaves the ones a person set, and asks nothing.",
    async run(_settings, deps): Promise<StepResult> {
      const seams = { env: { ...deps.env, HOME: deps.env.HOME ?? deps.home }, clones: deps.clones };
      const roots = hostRepositories(deps.clones);
      if (roots.length === 0) return { ok: true, detail: "the host file names no repositories, so Codex has none to trust" };
      const answers = roots.map((root) => ({ root, answer: ensureTrusted(root, seams) }));
      return { ok: answers.every(({ answer }) => answer.kind !== "refused"), detail: answers.map(({ root, answer }) => trustLine(root, answer)).join("\n") };
    },
  },
];
