// THE `messaging` KEY OF `.agent-org/project.json`, READ THE WAY `causes` IS (a11ign/a11ign#2901; docs/messaging.md decision 1, "Optional
// and off by default"). A LEAF module: it imports nothing from the tool, so it cannot use `ProjectDeclarationRefusal` or
// `readProjectDeclaration` and states its own refusal and its own read.
//
// **ABSENT IS OFF, AND OFF CONSTRUCTS NOTHING.** `{ enabled: false }` carries no provider, no path and no timezone, so a caller that
// forgot to look at `enabled` has nothing to send through and nothing to read. **A MALFORMED KEY IS A NAMED REFUSAL, NEVER A SILENT OFF**:
// a chairman who typed `"tokenfile"` and was told nothing is a chairman who believes the summary is coming at 08:00 and it never does.
// For the same reason an unknown key refuses (an underscore-prefixed one is prose, as everywhere in this file) and `null` is not absent.
//
// **THE PATHS ARE REFERENCES.** `tokenFile` and `chairmanFile` name files under `~/.config/agent-org/` and are returned resolved; the
// content is `secret.ts`'s business and is never read here. A path that climbs out of that directory is refused, so the key cannot be
// pointed at `/etc/shadow` and have the secret reader's error describe it.
//
// **`milestones` IS A PATH TOO, BUT TO A FILE THE PROJECT OWNS (a11ign/a11ign#3414):** relative to the project root, returned resolved, and refused if it
// climbs out of the root. Absent is `null` and constructs no milestone source, as an absent `summary` does. The file's content is `sources/milestones.ts`'s
// business and `messaging:check` validates it; this module never opens it.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const PROJECT_FILE = ".agent-org/project.json";
/** Where a secret reference may point, relative to the home directory. */
export const SECRET_DIRECTORY = ".config/agent-org";
/** The providers a configuration may name. A provider's own module is a later row; naming one here is what lets it be refused by name. */
export const KNOWN_PROVIDERS = Object.freeze(["telegram"]);
/** The field defaults of a summary that is DECLARED. It is not what an absent `summary` key means: that is no summary at all. */
export const DEFAULT_SUMMARY = Object.freeze({ at: "08:00", timezone: "Europe/London" });

const ALLOWED_KEYS = new Set(["provider", "tokenFile", "chairmanFile", "summary", "milestones"]);
const ALLOWED_SUMMARY_KEYS = new Set(["at", "timezone"]);
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A configuration that is present and wrong. `field` is a dotted path (`messaging.summary.at`) and `source` names the file read. */
export class MessagingConfigRefusal extends Error {
  field: string;

  constructor(field: string, reason: string, source: string = PROJECT_FILE, options: { cause?: unknown; } = {}) {
    super(`${source}: ${field}: ${reason}`, options);
    this.name = "MessagingConfigRefusal";
    this.field = field;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A name for the type, for a message that must say what it found instead. */
function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : typeof value;
}

function refuseUnknownKeys(holder: Record<string, unknown>, allowed: Set<string>, where: string, source: string) {
  for (const key of Object.keys(holder)) {
    if (key.startsWith("_") || allowed.has(key)) continue;
    throw new MessagingConfigRefusal(`${where}.${key}`, `unknown key (known: ${[...allowed].join(", ")})`, source);
  }
}

function readProvider(provider: unknown, source: string): string {
  if (typeof provider !== "string" || provider === "") {
    throw new MessagingConfigRefusal("messaging.provider", `it must be a non-empty string, not ${describe(provider)}`, source);
  }
  if (!KNOWN_PROVIDERS.includes(provider)) {
    throw new MessagingConfigRefusal("messaging.provider", `\`${provider}\` is not a provider (known: ${KNOWN_PROVIDERS.join(", ")})`, source);
  }
  return provider;
}

/**
 * A reference to a secret-bearing file, resolved against the home directory and confined to `~/.config/agent-org/`.
 */
function readSecretReference(value: unknown, field: string, home: string, source: string): string {
  if (typeof value !== "string" || value === "") {
    throw new MessagingConfigRefusal(field, `it must be a non-empty string, not ${describe(value)}`, source);
  }
  const directory = join(home, SECRET_DIRECTORY);
  const resolved = resolve(value.startsWith("~/") ? join(home, value.slice(2)) : value);
  if (!resolved.startsWith(directory + sep)) {
    throw new MessagingConfigRefusal(field, `\`${value}\` is not a file under ~/${SECRET_DIRECTORY}/ (a secret is read by reference from there and nowhere else)`, source);
  }
  return resolved;
}

function readSummaryTime(at: unknown, source: string): string {
  if (typeof at !== "string" || !TIME_OF_DAY.test(at)) {
    throw new MessagingConfigRefusal("messaging.summary.at", `${JSON.stringify(at)} is not a 24-hour HH:MM time`, source);
  }
  return at;
}

/** `Intl` is the one authority on which zones exist, and it is the one the summary's own date arithmetic will use. */
function readTimezone(timezone: unknown, source: string) {
  if (typeof timezone !== "string" || timezone === "") {
    throw new MessagingConfigRefusal("messaging.summary.timezone", `it must be a non-empty string, not ${describe(timezone)}`, source);
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
  } catch (cause) {
    throw new MessagingConfigRefusal("messaging.summary.timezone", `\`${timezone}\` is not a timezone this runtime knows`, source, { cause });
  }
  return timezone;
}

/**
 * THE SUMMARY IS OPT-IN: an absent key is `null` and constructs no summary source (chairman, 2026-10-04: "the chairman does not want a daily
 * message"). A PRESENT key keeps its field defaults, so `summary: {}` asks for the 08:00 London one.
 */
function readSummary(summary: unknown, source: string): { at: string; timezone: string; } | null {
  if (summary === undefined) return null;
  if (!isObject(summary)) throw new MessagingConfigRefusal("messaging.summary", `it must be an object, not ${describe(summary)}`, source);
  const holder = summary;
  refuseUnknownKeys(holder, ALLOWED_SUMMARY_KEYS, "messaging.summary", source);
  // `=== undefined` and not `??`: an explicit `null` is a malformed value to refuse, not an absent one to default.
  return {
    at: readSummaryTime(holder.at === undefined ? DEFAULT_SUMMARY.at : holder.at, source),
    timezone: readTimezone(holder.timezone === undefined ? DEFAULT_SUMMARY.timezone : holder.timezone, source),
  };
}

/**
 * THE MILESTONES FILE IS OPT-IN: an absent key is `null`. A present one is a path inside the project, resolved against its root.
 */
function readMilestonesPath(value: unknown, root: string, source: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value === "") {
    throw new MessagingConfigRefusal("messaging.milestones", `it must be a non-empty path, not ${describe(value)}`, source);
  }
  const resolved = resolve(root, value);
  if (!resolved.startsWith(resolve(root) + sep)) {
    throw new MessagingConfigRefusal("messaging.milestones", `\`${value}\` is not a file inside the project (the declaration is the project's own and is read from there)`, source);
  }
  return resolved;
}

export type MessagingOff = { enabled: false };
export type MessagingOn = { enabled: true; provider: string; tokenFile: string; chairmanFile: string; summary: { at: string; timezone: string } | null; milestones: string | null };

/**
 * PURE: a test drives every refusal with a plain object. `parsed` is the whole parsed `project.json`;
 * `home` is where `~` and the secret directory are anchored, `root` where `milestones` is.
 */
export function parseMessagingConfig(parsed: unknown, { home = homedir(), source = PROJECT_FILE, root = process.cwd() }: { home?: string; source?: string; root?: string; } = {}): MessagingOff | MessagingOn {
  if (!isObject(parsed)) throw new MessagingConfigRefusal("(file)", "it must be a JSON object", source);
  const document = parsed;
  if (!Object.hasOwn(document, "messaging")) return { enabled: false };
  const key = document.messaging;
  if (!isObject(key)) throw new MessagingConfigRefusal("messaging", `it must be an object, not ${describe(key)}`, source);
  const holder = key;
  refuseUnknownKeys(holder, ALLOWED_KEYS, "messaging", source);
  return {
    enabled: true,
    provider: readProvider(holder.provider, source),
    tokenFile: readSecretReference(holder.tokenFile, "messaging.tokenFile", home, source),
    chairmanFile: readSecretReference(holder.chairmanFile, "messaging.chairmanFile", home, source),
    summary: readSummary(holder.summary, source),
    milestones: readMilestonesPath(holder.milestones, root, source),
  };
}

/**
 * Read `<root>/.agent-org/project.json`'s `messaging` key. An unreadable or unparseable file is a refusal and not "off": the file
 * that says whether to message the chairman being unreadable is not the same fact as its saying no.
 */
export function readMessagingConfig(root: string, { home, read = readFileSync }: { home?: string; read?: typeof readFileSync; } = {}): MessagingOff | MessagingOn {
  const path = join(root, PROJECT_FILE);
  let text: string;
  try {
    text = String(read(path, "utf8"));
  } catch (cause) {
    throw new MessagingConfigRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new MessagingConfigRefusal("(file)", "it is not valid JSON", path, { cause });
  }
  return parseMessagingConfig(parsed, { home, source: path, root });
}
