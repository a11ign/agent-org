// @ts-check
// module: what the project's `messaging` key says, read from `project.json` for `agent-org plugin list` and doctor (A11-158)
//
// MESSAGING IS CONFIGURED IN `project.json`, not in a provider block, until A11-162 moves it onto the registry. This reads that file's text and the provider the key names, and
// nothing the key points at: a token file is not opened. An unreadable file is a state with its reason, never a thrown error, so a list or a doctor run says it and goes on.
import { readFileSync } from "node:fs";
import { projectPathOf } from "../ticket-mode/settings-read.ts";
import type { MessagingState } from "./view.ts";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The messaging state of the primary project (or `projectPath`, a test's) for a parsed host file. */
export async function messagingStateOf(host: Record<string, unknown>, projectPath?: string): Promise<MessagingState> {
  try {
    const path = projectPath ?? (await projectPathOf({}, host));
    if (path === null) return { provider: null, why: "this machine declares no project, so messaging is not configured" };
    const messaging = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).messaging;
    if (!isObject(messaging)) return { provider: null, why: "project.json has no messaging key, so messaging is off" };
    return typeof messaging.provider === "string" ? { provider: messaging.provider } : { provider: null, why: "project.json's messaging key names no provider" };
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
