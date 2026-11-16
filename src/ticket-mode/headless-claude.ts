// @ts-check
// module: the headless `claude` a board feature asks one question of (A11-432's retro, A11-443's readiness score) -- a leaf, so the request thread can ask it without the retro's imports
//
// NO TOOL, NO MCP SERVER, NO SESSION KEPT, NO PERMISSION PROMPT: the prompt is read from stdin and the answer is one JSON result. Each caller names its model, the most one run may spend and how long
// it may take; the run is started through the `exec` it is handed (`realExecAsync`, under `execFile`), so it never holds a thread's loop.
import type { ExecResult } from "../plugins/manifest.ts";

/** The model a headless run asks, the most it may spend in dollars, and how long it may run before it is cut. */
export type ClaudeBounds = Readonly<{ model: string; maxBudgetUsd: number; timeoutMs: number }>;

/** The turns a run may take: one answer, with no tool to call, needs one. */
const MAX_TURNS = 2;

/** The env a headless run adds: the account's claude.ai connectors off, as the eval's worker has them (`run-eval/sandbox.ts`). */
export const HEADLESS_ENV: Readonly<Record<string, string>> = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" };

/** The arguments of a headless run within `bounds`: no tool, no MCP server (nor the account's connectors, {@link HEADLESS_ENV}), no session kept, no permission prompt, its result as JSON. PURE. */
export function headlessArgs(bounds: ClaudeBounds): string[] {
  return ["-p", "--output-format", "json", "--model", bounds.model, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none",
    "--max-turns", String(MAX_TURNS), "--max-budget-usd", String(bounds.maxBudgetUsd)];
}

export type HeadlessExec = (file: string, args: readonly string[], options: { timeoutMs: number; cwd: string; input: string; env: Readonly<Record<string, string>> }) => Promise<ExecResult>;

/** Ask `claude` through `exec`, in `cwd`, the prompt on stdin, within `bounds`. */
export function askHeadless(exec: HeadlessExec, cwd: string, bounds: ClaudeBounds): (prompt: string) => Promise<ExecResult> {
  return (prompt) => exec("claude", headlessArgs(bounds), { timeoutMs: bounds.timeoutMs, cwd, input: prompt, env: HEADLESS_ENV });
}
