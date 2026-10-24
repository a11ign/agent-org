// @ts-check
// module: the atomic reviewer's doctor checks (A11-161) -- the gate's modules load, and Codex, which the reviewer runs on, is on the path and logged in
//
// MOVED OUT OF `install/doctor.ts` (`reviewerExtras`, `codexChecks`) with their words. They are asked only of an enabled atomic reviewer: a disabled one needs neither the gate nor Codex.
// Onboard installs neither Codex nor its login, since that needs the person's account, so each failure names the one thing to do.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { hostRepositories, untrustedHostRepositories } from "./codex-trust.ts";

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

/** The entry Codex's config needs for a root, as the words of a fix. */
const entryOf = (root: string): string => `\`[projects."${root}"]\``;

/** The fix for the host repositories Codex does not trust: onboard adds an absent entry, and an entry a person set is theirs to change. */
function trustFixOf(untrusted: readonly { root: string; level: string }[], file: string): string {
  const absent = untrusted.filter(({ level }) => level === "absent").map(({ root }) => entryOf(root));
  const set = untrusted.filter(({ level }) => level !== "absent");
  const adding = absent.length === 0 ? [] : [`run \`agent-org onboard\` again, or add ${absent.join(" and ")} with \`trust_level = "trusted"\` to ${file}`];
  const changing = set.map(({ root, level }) => `set \`trust_level = "trusted"\` in ${entryOf(root)} of ${file} (it says \`${level}\`, which agent-org leaves as a person set it)`);
  return [...adding, ...changing].join("; ");
}

/** Whether Codex trusts every repository the host file names (A11-221): an untrusted one stops a review on Codex's "Trust this folder?" dialog. Reads Codex's config and never writes it. */
export function trustChecks(deps: Pick<PluginDeps, "env" | "clones">): PluginCheck[] {
  if (hostRepositories(deps.clones).length === 0) return [ok("codex trust", "the host file names no repositories, so Codex has none to trust")];
  const found = untrustedHostRepositories(deps);
  if ("refusal" in found) return [failed("codex trust", found.refusal, `fix ${found.file} (or move it aside so Codex writes a new one), then run \`agent-org doctor\` again`)];
  if (found.untrusted.length === 0) return [ok("codex trust", `Codex trusts every repository the host file names (${found.file})`)];
  const named = found.untrusted.map(({ root, level }) => (level === "absent" ? `${root} (no entry)` : `${root} (${level})`));
  return [failed("codex trust", `Codex does not trust ${named.join(", ")}: a review there stops on its "Trust this folder?" dialog`, trustFixOf(found.untrusted, found.file))];
}

/** The gate's check (its modules must load, or no reviewer starts a run, A11-144), Codex (A11-145) and Codex's trust of the host file's repositories (A11-221). */
export async function atomicChecks(_settings: PluginSettings, deps: PluginDeps): Promise<readonly PluginCheck[]> {
  await deps.reviewing.loadGate();
  const refusal = deps.reviewing.gateRefusal();
  const gate = refusal === null ? ok("reviewer gate", "the gate's modules load") : failed("reviewer gate", refusal, "fix what it names: no reviewer starts while the gate does not load");
  return [gate, ...codexChecks(deps), ...trustChecks(deps)];
}
