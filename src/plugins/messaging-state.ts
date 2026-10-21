// @ts-check
// module: what the project's `messaging` key says, read from `project.json` for `agent-org plugin` and doctor (A11-158, A11-162)
//
// MESSAGING IS CONFIGURED IN `project.json`, not in a provider block (A11-157 Decision 7: the key keeps its place, and `agent-org plugin` writes it). This reads that file's text: the
// provider the key names, whether it is enabled (absent is true), and the rest of the key as the plugin's settings. Nothing the key points at is opened: a token file is not read. An
// unreadable file is a state with its reason, never a thrown error, so a list or a doctor run says it and goes on.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { MessagingConfigRefusal, readMessagingConfig } from "../messaging/config.ts";
import { loadMessagingModule, messagingPluginDeps, pluginSettingsOf } from "../messaging/plugin.ts";
import { projectPathOf } from "../ticket-mode/settings-read.ts";
import type { PluginCheck } from "./manifest.ts";
import type { MessagingState } from "./view.ts";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The messaging state of the primary project (or `projectPath`, a test's) for a parsed host file. */
export async function messagingStateOf(host: Record<string, unknown>, projectPath?: string): Promise<MessagingState> {
  try {
    const path = projectPath ?? (await projectPathOf({}, host));
    if (path === null) return { provider: null, why: "this machine declares no project, so messaging is not configured" };
    const messaging = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).messaging;
    if (!isObject(messaging)) return { provider: null, why: "project.json has no messaging key, so messaging is off" };
    if (typeof messaging.provider !== "string") return { provider: null, why: "project.json's messaging key names no provider" };
    const { provider, enabled, ...settings } = messaging;
    return { provider: String(provider), enabled: enabled !== false, settings };
  } catch (error) {
    return { provider: null, why: `project.json could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The messaging state for the host file at `hostPath`: a host file that cannot be read says so. */
export async function messagingStateOfFile(hostPath: string, projectPath?: string): Promise<MessagingState> {
  try {
    const host: unknown = JSON.parse(readFileSync(hostPath, "utf8"));
    if (isObject(host)) return await messagingStateOf(host, projectPath);
  } catch {
    // falls through to the state below
  }
  return { provider: null, why: `the host file ${hostPath} cannot be read, so project.json is not found` };
}

/**
 * The doctor rows the enabled messaging plugin declares, for the files the project's `messaging` key resolves to (A11-162): the key is read by the messaging reader (which resolves `~` and
 * confines each path to `~/.config/agent-org/`), the plugin is loaded from the registry, and its checks are asked. A key the reader refuses is the failure, in the reader's words; a project
 * with no messaging, or with the plugin switched off, has no rows. THROWS the reader's or the loader's refusal, and the caller says it as a row.
 */
export async function messagingChecksOfFile(hostPath: string, context: Readonly<{ env: Readonly<Record<string, string | undefined>>; home: string }>): Promise<readonly PluginCheck[]> {
  const host: unknown = JSON.parse(readFileSync(hostPath, "utf8"));
  const path = await projectPathOf({}, isObject(host) ? host : {});
  if (path === null) return [];
  const config = readMessagingConfig(dirname(dirname(path)), { home: context.home });
  if (!config.enabled) return [];
  const { module } = await loadMessagingModule(config.provider);
  return module.doctorChecks(pluginSettingsOf(config), messagingPluginDeps(context));
}

export { MessagingConfigRefusal };
