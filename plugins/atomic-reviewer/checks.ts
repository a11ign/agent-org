// @ts-check
// module: the atomic reviewer's doctor checks (A11-161) -- the gate's modules load, and Codex, which the reviewer runs on, is on the path and logged in
//
// MOVED OUT OF `install/doctor.ts` (`reviewerExtras`, `codexChecks`) with their words. They are asked only of an enabled atomic reviewer: a disabled one needs neither the gate nor Codex.
// Onboard installs neither Codex nor its login, since that needs the person's account, so each failure names the one thing to do.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** How long `codex login status` is given. */
export const CODEX_MS = 60_000;

/** Where `codex` is on the path, or null when it is not. */
export function codexPath(deps: Pick<PluginDeps, "exec">): string | null {
  const found = deps.exec("which", ["codex"]);
  return found.status === 0 && found.stdout.trim() !== "" ? found.stdout.trim().split("\n")[0] : null;
}

/** The exit status of `codex login status`, or null when it cannot run. */
export const codexStatus = (deps: Pick<PluginDeps, "exec">): number | null => deps.exec("codex", ["login", "status"], { timeoutMs: CODEX_MS }).status;

/** Codex, which the atomic reviewer runs on (A11-145): on the path, and logged in. */
export function codexChecks(deps: Pick<PluginDeps, "exec">): PluginCheck[] {
  const path = codexPath(deps);
  if (path === null) return [failed("codex", "`codex` is not on PATH, so the atomic reviewer cannot run", "install Codex (`npm install -g @openai/codex`), then run `codex login`")];
  const status = codexStatus(deps);
  if (status === 0) return [ok("codex", `${path}, logged in`)];
  return [failed("codex", status === null ? `${path} could not run \`codex login status\`` : "Codex is not logged in", "run `codex login`, then `agent-org doctor` again")];
}

/** The gate's check (its modules must load, or no reviewer starts a run, A11-144) and Codex (A11-145). */
export async function atomicChecks(_settings: PluginSettings, deps: PluginDeps): Promise<readonly PluginCheck[]> {
  await deps.reviewing.loadGate();
  const refusal = deps.reviewing.gateRefusal();
  const gate = refusal === null ? ok("reviewer gate", "the gate's modules load") : failed("reviewer gate", refusal, "fix what it names: no reviewer starts while the gate does not load");
  return [gate, ...codexChecks(deps)];
}
