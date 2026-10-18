// A leaf of ticket mode, run by no command: the background work a worker's session has running, read from its transcript (the stop hook) or its pane (the board). PURE.
//
// CLAUDE CODE WAKES A SESSION ONLY FOR WORK IT STARTED ITSELF: a Bash call with `run_in_background`, or a Monitor. A process the worker detached on its
// own (`nohup`, `&`, `setsid`, a unit) wakes nothing when it ends, which is the A11-31 case, so it is not counted here (the control test pins it).

/** The background work a transcript shows as started and not yet ended: the ids of its shells and of its monitors, in the order they started. */
export type LiveBackgroundWork = Readonly<{ shells: readonly string[]; monitors: readonly string[] }>;

/** The background work a pane's status line counts, `· 1 shell, 1 monitor`: zero for each kind the line does not show. */
export type PaneBackgroundWork = Readonly<{ shells: number; monitors: number }>;

type Kind = "shell" | "monitor";

/** The text of a message's content: a string, or the text blocks of a list. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block as { text?: unknown })?.text).filter((text): text is string => typeof text === "string").join("\n");
}

/** A line's JSON record, or null when the line is not JSON: such a line is skipped, never fatal. */
function recordOf(line: string): Record<string, unknown> | null {
  try {
    const record = JSON.parse(line) as unknown;
    return record !== null && typeof record === "object" ? record as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The background work a session's transcript shows as live. A Bash call with `run_in_background: true`, answered `Command running in background with
 * ID: <id>`, is a shell; a Monitor, answered `Monitor started (task <id>, ...`, is a monitor. Each ends on its `<task-notification>` (in a user message or
 * a queue operation) with a `<status>` of completed, failed, killed or stopped, or an expiry notice (a Monitor that ran out of time), or on a TaskStop
 * call naming its id. A notification with no status and no expiry is an event of a running monitor, and ends nothing.
 */
export function liveBackgroundWork(transcript: string): LiveBackgroundWork {
  const pending = new Map<string, Kind>();
  const started = new Map<string, Kind>();
  const ended = new Set<string>();
  for (const line of transcript.split("\n")) {
    const record = line.trim() === "" ? null : recordOf(line);
    if (record === null) continue;
    const message = record.message as { content?: unknown } | undefined;
    if (record.type === "assistant" && Array.isArray(message?.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type !== "tool_use") continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (block.name === "Bash" && input.run_in_background === true) pending.set(String(block.id), "shell");
        else if (block.name === "Monitor") pending.set(String(block.id), "monitor");
        else if (block.name === "TaskStop") for (const value of Object.values(input)) if (typeof value === "string") ended.add(value);
      }
    }
    if (record.type === "user" && Array.isArray(message?.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type !== "tool_result" || !pending.has(String(block.tool_use_id))) continue;
        const text = textOf(block.content);
        const shell = /Command running in background with ID: ([\w-]+)/.exec(text);
        const monitor = /Monitor started \(task ([\w-]+)/.exec(text);
        const kind = pending.get(String(block.tool_use_id))!;
        const id = kind === "shell" ? shell?.[1] : monitor?.[1];
        if (id !== undefined) started.set(id, kind);
        pending.delete(String(block.tool_use_id));
      }
    }
    const notice = notificationOf(record);
    if (notice !== null && (/^<status>(completed|failed|killed|stopped)<\/status>$/m.test(notice.body) || /\[Monitor expired/.test(notice.body))) ended.add(notice.id);
  }
  const live = [...started].filter(([id]) => !ended.has(id));
  return { shells: live.filter(([, kind]) => kind === "shell").map(([id]) => id), monitors: live.filter(([, kind]) => kind === "monitor").map(([id]) => id) };
}

/** A `<task-notification>` a user message or a queue operation carries: its task id and its text. Null for any other record. */
function notificationOf(record: Record<string, unknown>): { id: string; body: string } | null {
  if (record.type !== "user" && record.type !== "queue-operation") return null;
  const text = record.type === "user" ? textOf((record.message as { content?: unknown } | undefined)?.content) : textOf(record.content);
  if (!text.trimStart().startsWith("<task-notification>")) return null;
  const id = /<task-id>([\w-]+)<\/task-id>/.exec(text)?.[1];
  return id === undefined ? null : { id, body: text };
}

/**
 * The background work a pane's status line counts: `⏵⏵ bypass permissions on · 1 shell, 1 monitor` (verified on a live pane, 2026-10-17). Zero for
 * each kind the pane does not show, so a pane with no background work reads as zero, and a pane that cannot be read is the caller's to judge.
 */
export function paneBackgroundWork(pane: string): PaneBackgroundWork {
  const count = (pattern: RegExp) => {
    const matches = [...pane.matchAll(pattern)];
    return matches.length === 0 ? 0 : Number.parseInt(matches[matches.length - 1][1], 10);
  };
  return { shells: count(/[·,]\s*(\d+) shells?\b/g), monitors: count(/[·,]\s*(\d+) monitors?\b/g) };
}
