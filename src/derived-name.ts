// @ts-check
// no-token: none -- pure functions; nothing is spawned
//
// A11-259: THE ONE FUNCTION THAT TURNS A REAL NAME INTO A NAME SOME RULE ACCEPTS. A name built from a repository name (`a11ign.github.io`) used to be cleaned in one place (herdr's agent name, A11-241) and only
// REFUSED in another (the reviewer key), so a dotted repository could never be reviewed. Both now go through {@link derivedName}, each with its own {@link NameRule}; the real name stays the human label
// everywhere a person reads one, and only the machine name is derived. {@link cloneKeys} keeps the keys of the host's clones distinct from each other and from the project's declared keys.
import { createHash } from "node:crypto";

/** What one consumer accepts as a name. */
export type NameRule = Readonly<{
  /** The characters a name may hold, as the inside of a regular expression's character class (`a-z0-9_-`). Any other character becomes `-`, after the name is lowercased. */
  chars: string;
  /** The name must start with a lowercase letter; one that does not is prefixed `x-`. */
  startsWithLetter?: boolean;
  /** Runs of `-` are collapsed, a leading or trailing `-` is trimmed, and a name left empty is `repo`. */
  tidy?: boolean;
  /** The name may end in `-<digits>`. When it may not, `-repo` is appended to one that does. */
  trailingNumber: boolean;
  /** The longest name. A longer one becomes `<head><tail>-<hash>` ({@link derivedName}). */
  maxLength?: number;
}>;

/** herdr 0.9.3's rule for an agent's name (measured 2026-10-25, `invalid_agent_name ... (1-32 characters)`): `^[a-z][a-z0-9_-]{0,31}$`. A name is only cleaned, never tidied. */
export const HERDR_AGENT_RULE: NameRule = { chars: "a-z0-9_-", startsWithLetter: true, trailingNumber: true, maxLength: 32 };

/**
 * The rule of a reviewer's repository key (`review-attribution.ts` `reviewerInstance`): lowercase letters, digits and hyphens, not ending in `-<digits>`, because a seat label `reviewer-<key>-<n>` is read
 * back from the right. It has no length limit: the seat label's own herdr name is shortened by `herdrAgentName`.
 */
export const REVIEWER_KEY_RULE: NameRule = { chars: "a-z0-9-", tidy: true, trailingNumber: false };

const HASH_LENGTH = 8;
/** The longest trailing `-<digits>` kept readable in a shortened name; a longer one is left to the hash. */
const TAIL_MAX = 12;
const COLLISION_HASH_LENGTH = 7;
const TRAILING_NUMBER = /-[0-9]+$/;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Whether `name` is one `rule` accepts as it is. */
export function isName(name: string, rule: NameRule): boolean {
  return name !== ""
    && new RegExp(`^[${rule.chars}]+$`).test(name)
    && (rule.startsWithLetter !== true || /^[a-z]/.test(name))
    && (rule.trailingNumber || !TRAILING_NUMBER.test(name))
    && (rule.maxLength === undefined || name.length <= rule.maxLength);
}

/** Whether `key` is a reviewer's repository key (`""`, the primary's, is none). */
export const isReviewerKey = (key: string): boolean => isName(key, REVIEWER_KEY_RULE);

/**
 * The name `rule` accepts for `real` (PURE, deterministic). A name the rule already accepts, after lowercasing, comes back unchanged, so nothing that works today is renamed. Any other has its disallowed characters
 * made `-`, is tidied, prefixed `x-` and suffixed `-repo` where the rule asks, and, if still over the rule's length, becomes `<head><tail>-<hash>`: the head of the name (so a prefix a reader sorts by
 * survives), a trailing `-<number>` when it is short enough to keep, and 8 hex characters (32 bits) of SHA-256 of the REAL name, so two long names that share a prefix and a number stay two names.
 */
export function derivedName(real: string, rule: NameRule): string {
  const lowered = real.toLowerCase();
  if (isName(lowered, rule)) return lowered;
  let name = lowered.replace(new RegExp(`[^${rule.chars}]`, "g"), "-");
  if (rule.tidy === true) name = name.replace(/-{2,}/g, "-").replace(/^-|-$/g, "") || "repo";
  if (rule.startsWithLetter === true && !/^[a-z]/.test(name)) name = `x-${name}`;
  if (!rule.trailingNumber && TRAILING_NUMBER.test(name)) name = `${name}-repo`;
  if (rule.maxLength === undefined || name.length <= rule.maxLength) return name;
  const number = TRAILING_NUMBER.exec(name)?.[0] ?? "";
  const tail = number.length > TAIL_MAX ? "" : number;
  const head = name.slice(0, rule.maxLength - tail.length - 1 - HASH_LENGTH).replace(/[-_]+$/, "");
  return `${head}${tail}-${sha256(real).slice(0, HASH_LENGTH)}`;
}

/**
 * The reviewer key of each of the host's clones, by the clone's name (`host.json`'s `clones`) (PURE, deterministic, the same in any order of `clones`). A key is `derivedName(name, REVIEWER_KEY_RULE)`
 * (`a11ign.github.io` is `a11ign-github-io`), and a key two clones or a clone and a declared key (`declared`, the project's) would share is made distinct: a declared key keeps it, then a clone whose real
 * name IS the key (it was valid already, so its running seats keep their names), and every other clone takes `<key>-h<7 hex of SHA-256 of its real name>`. The `h` means the suffix never reads as `-<digits>`.
 */
export function cloneKeys(clones: Readonly<Record<string, unknown>>, declared: readonly string[]): ReadonlyMap<string, string> {
  const names = Object.keys(clones);
  const bases = new Map(names.map((name) => [name, derivedName(name, REVIEWER_KEY_RULE)]));
  const claimants = (base: string): string[] => names.filter((name) => bases.get(name) === base);
  return new Map(names.map((name) => {
    const base = bases.get(name)!;
    const keepsBase = !declared.includes(base) && (name === base || claimants(base).length === 1);
    return [name, keepsBase ? base : `${base}-h${sha256(name).slice(0, COLLISION_HASH_LENGTH)}`];
  }));
}
