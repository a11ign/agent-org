// @ts-check
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
// content is `secret.mjs`'s business and is never read here. A path that climbs out of that directory is refused, so the key cannot be
// pointed at `/etc/shadow` and have the secret reader's error describe it.
//
// **`milestones` IS A PATH TOO, BUT TO A FILE THE PROJECT OWNS (a11ign/a11ign#3414):** relative to the project root, returned resolved, and refused if it
// climbs out of the root. Absent is `null` and constructs no milestone source, as an absent `summary` does. The file's content is `sources/milestones.mjs`'s
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
  /** @param {string} field @param {string} reason @param {string} [source] @param {{ cause?: unknown }} [options] */
  constructor(field, reason, source = PROJECT_FILE, options = {}) {
    super(`${source}: ${field}: ${reason}`, options);
    this.name = "MessagingConfigRefusal";
    this.field = field;
  }
}

/** @param {unknown} value */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {string} a name for the type, for a message that must say what it found instead */
function describe(value) {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : typeof value;
}

/**
 * @param {Record<string, unknown>} holder @param {Set<string>} allowed @param {string} where @param {string} source
 */
function refuseUnknownKeys(holder, allowed, where, source) {
  for (const key of Object.keys(holder)) {
    if (key.startsWith("_") || allowed.has(key)) continue;
    throw new MessagingConfigRefusal(`${where}.${key}`, `unknown key (known: ${[...allowed].join(", ")})`, source);
  }
}

/** @param {unknown} provider @param {string} source @returns {string} */
function readProvider(provider, source) {
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
 * @param {unknown} value @param {string} field @param {string} home @param {string} source @returns {string}
 */
function readSecretReference(value, field, home, source) {
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

/** @param {unknown} at @param {string} source @returns {string} */
function readSummaryTime(at, source) {
  if (typeof at !== "string" || !TIME_OF_DAY.test(at)) {
    throw new MessagingConfigRefusal("messaging.summary.at", `${JSON.stringify(at)} is not a 24-hour HH:MM time`, source);
  }
  return at;
}

/** `Intl` is the one authority on which zones exist, and it is the one the summary's own date arithmetic will use. @param {unknown} timezone @param {string} source */
function readTimezone(timezone, source) {
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
 * @param {unknown} summary @param {string} source @returns {{ at: string, timezone: string } | null}
 */
function readSummary(summary, source) {
  if (summary === undefined) return null;
  if (!isObject(summary)) throw new MessagingConfigRefusal("messaging.summary", `it must be an object, not ${describe(summary)}`, source);
  const holder = /** @type {Record<string, unknown>} */ (summary);
  refuseUnknownKeys(holder, ALLOWED_SUMMARY_KEYS, "messaging.summary", source);
  // `=== undefined` and not `??`: an explicit `null` is a malformed value to refuse, not an absent one to default.
  return {
    at: readSummaryTime(holder.at === undefined ? DEFAULT_SUMMARY.at : holder.at, source),
    timezone: readTimezone(holder.timezone === undefined ? DEFAULT_SUMMARY.timezone : holder.timezone, source),
  };
}

/**
 * THE MILESTONES FILE IS OPT-IN: an absent key is `null`. A present one is a path inside the project, resolved against its root.
 * @param {unknown} value @param {string} root @param {string} source @returns {string | null}
 */
function readMilestonesPath(value, root, source) {
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

/** @typedef {{ enabled: false }} MessagingOff */
/** @typedef {{ enabled: true, provider: string, tokenFile: string, chairmanFile: string, summary: { at: string, timezone: string } | null, milestones: string | null }} MessagingOn */

/**
 * PURE: a test drives every refusal with a plain object.
 * @param {unknown} parsed the whole parsed `project.json`
 * @param {{ home?: string, source?: string, root?: string }} [options] `home` is where `~` and the secret directory are anchored, `root` where `milestones` is
 * @returns {MessagingOff | MessagingOn}
 */
export function parseMessagingConfig(parsed, { home = homedir(), source = PROJECT_FILE, root = process.cwd() } = {}) {
  if (!isObject(parsed)) throw new MessagingConfigRefusal("(file)", "it must be a JSON object", source);
  const document = /** @type {Record<string, unknown>} */ (parsed);
  if (!Object.hasOwn(document, "messaging")) return { enabled: false };
  const key = document.messaging;
  if (!isObject(key)) throw new MessagingConfigRefusal("messaging", `it must be an object, not ${describe(key)}`, source);
  const holder = /** @type {Record<string, unknown>} */ (key);
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
 * @param {string} root @param {{ home?: string, read?: typeof readFileSync }} [deps]
 * @returns {MessagingOff | MessagingOn}
 */
export function readMessagingConfig(root, { home, read = readFileSync } = {}) {
  const path = join(root, PROJECT_FILE);
  /** @type {string} */
  let text;
  try {
    text = String(read(path, "utf8"));
  } catch (cause) {
    throw new MessagingConfigRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new MessagingConfigRefusal("(file)", "it is not valid JSON", path, { cause });
  }
  return parseMessagingConfig(parsed, { home, source: path, root });
}
