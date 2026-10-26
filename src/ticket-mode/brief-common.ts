// @ts-check
// module: the pieces every run's brief shares -- what to do when a skill is missing, which commands stall an unattended run, the connectors section, and a quoted description

/** What a worker does when a skill its brief names is missing: a copy of the skill's files, read by hand, is not the skill and its helpers. */
export const MISSING_SKILL = "If a skill this brief names is not available in this session, write a `needs-human` outcome naming it, rather than following a copy of its files.";

/** What an unattended run does with a command Claude Code would stop to ask a person about (A11-174, A11-209): the pool answers that prompt No, whether the main agent or one of its subagents raised it, so the command is written to raise none. */
export const STALLING_COMMANDS = "## Commands that stall an unattended run\n\nClaude Code still asks a person before some commands even with permissions bypassed, for example an `rm` on a path built from a variable that could be empty. Nobody answers on an unattended run. Always guard variable paths: `rm -rf \"${DIR:?}/x\"`, never `rm -rf $DIR/x`. The subagents you start inherit these rules, so tell them. Every delete names an explicit path guarded with `${VAR:?}`, never a bare `*` after `cd`.";

/** The connectors section of the brief, or nothing when the machine allows none. */
export function connectorsText(connectors: readonly string[]): string {
  if (connectors.length === 0) return "";
  return `
## Connectors

This machine lets you call the connector tools whose names match ${connectors.map((pattern) => `\`${pattern}\``).join(", ")}. Use them for what your ticket needs, such as reading its parent, the tickets that block it and related work. Every other connector is refused.
`;
}

/** A description quoted, so its own headings cannot read as the brief's. */
export const quoted = (description: string): string => (description.trim() || "(no description)").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
