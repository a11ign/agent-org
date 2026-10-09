// @ts-check
// #2621 (child 3e of #69): THE SHAPE OF A CAUSE DECLARATION, `{cause, group, profile}`, split out of
// `cause-declaration.ts` for one reason -- a LEAF, import-free like `claim-labels.ts`, because a project
// plugin (`.agent-org/plugins/causes.ts`) must build declarations with `declareCause` and `GROUPS`
// WITHOUT importing `cause-declaration.ts` itself. That file's own top-level await DYNAMICALLY IMPORTS
// the plugin to read the project's causes, so a plugin that imported it back would be a cycle neither
// side can finish: `cause-declaration.ts` awaits the plugin's module evaluation, which awaits
// `cause-declaration.ts`'s. Node calls this an "unsettled top-level await" and hangs rather than erroring
// (measured: a `timeout 5` run of exactly this shape here first).
//
// See `cause-declaration.ts`'s own header for the fuller design: two independent axes decide the four
// exported lists (`CAUSES`, `JUDGMENT_CAUSES`, `START_CAUSES`, `PROFILES`), and `GROUPS`'s own docblock
// there is where that reasoning lives.

export type CauseProfile = { kind: "claude"|"codex", model: string, effort: string, why: string };
export type CauseDeclaration = Readonly<{ cause: string, group: string, profile: Readonly<CauseProfile> }>;

/** The four groups a cause's membership in `CAUSES`/`JUDGMENT_CAUSES`/`START_CAUSES` is computed from. */
export const GROUPS = Object.freeze({
  /** Names a thing to do, and is never withheld by a drain: its subject is work the org already holds. */
  ACTION: "action",
  /** Names a thing to do, and starts work the org does not yet hold -- withheld by a drain. */
  ACTION_START: "action-start",
  /** Asks somebody to look and decide; durable, so `wake`'s expiry does not re-ask it. Never withheld. */
  JUDGMENT: "judgment",
  /** A judgment that also starts new work -- withheld by a drain. */
  JUDGMENT_START: "judgment-start",
});

// Widened to `Set<string>`: `group` arrives as untrusted `string` (JSON, a plugin), and `.has` on the
// literal-typed inference TS would otherwise give `Object.values(GROUPS)` refuses a plain string.
const KNOWN_GROUPS = (new Set(Object.values(GROUPS)) as Set<string>);

/** A refusal that names the cause it is about, so a caller (and a test) can tell which rule fired. */
export class CauseDeclarationRefusal extends Error {
  subject: string;
  /** @param {string} cause @param {string} reason @param {{ cause?: unknown }} [options] */
  constructor(cause: string, reason: string, options?: { cause?: unknown; }) {
    super(`cause "${cause}" REFUSED: ${reason}. Nothing is defaulted to another cause's group or profile.`, options);
    this.name = "CauseDeclarationRefusal";
    this.subject = cause;
  }
}

/**
 * ONE cause: its name, which of the four groups it belongs to, and the profile `worker-profile.ts`
 * routes it with. IT REFUSES, IT NEVER DEFAULTS: a missing group or a missing profile is refused naming
 * the cause, the same discipline `project-config.ts`'s reader holds itself to.
 * @param {string} cause
 * @param {string} group one of `GROUPS`'s values
 * @param {CauseProfile} profile
 * @returns {CauseDeclaration}
 */
export function declareCause(cause: string, group: string, profile: CauseProfile): CauseDeclaration {
  if (!cause || typeof cause !== "string") {
    throw new CauseDeclarationRefusal(String(cause), "the cause name is missing or not a non-empty string");
  }
  if (!KNOWN_GROUPS.has(group)) {
    throw new CauseDeclarationRefusal(cause, `group ${JSON.stringify(group)} is missing or not one of `
      + `${[...KNOWN_GROUPS].join(", ")}`);
  }
  if (!profile || typeof profile !== "object") {
    throw new CauseDeclarationRefusal(cause, "profile is missing");
  }
  return Object.freeze({ cause, group, profile: Object.freeze({ ...profile }) });
}

/**
 * Combine every list of declarations into one, refusing a cause declared twice -- a project's cause must
 * not reuse a tool cause's name, and two projects must not declare the same name either.
 * @param {readonly (readonly CauseDeclaration[])[]} lists
 * @returns {Readonly<CauseDeclaration[]>}
 */
export function declaredCauses(...lists: readonly (readonly CauseDeclaration[])[]): Readonly<CauseDeclaration[]> {
  const byName: Map<string, CauseDeclaration> = new Map();
  for (const list of lists) {
    for (const decl of list) {
      if (byName.has(decl.cause)) {
        throw new CauseDeclarationRefusal(decl.cause, "declared twice -- a project cause must not reuse "
          + "a name the tool, or another project, already declared");
      }
      byName.set(decl.cause, decl);
    }
  }
  return Object.freeze([...byName.values()]);
}

/** @param {readonly CauseDeclaration[]} declarations @returns {Readonly<string[]>} */
export function causesOf(declarations: readonly CauseDeclaration[]): Readonly<string[]> {
  return Object.freeze(declarations.map((d) => d.cause));
}

/** @param {readonly CauseDeclaration[]} declarations @returns {Readonly<string[]>} */
export function judgmentCausesOf(declarations: readonly CauseDeclaration[]): Readonly<string[]> {
  return Object.freeze(declarations.filter((d) => d.group === GROUPS.JUDGMENT || d.group === GROUPS.JUDGMENT_START)
    .map((d) => d.cause));
}

/** @param {readonly CauseDeclaration[]} declarations @returns {Readonly<string[]>} */
export function startCausesOf(declarations: readonly CauseDeclaration[]): Readonly<string[]> {
  return Object.freeze(declarations.filter((d) => d.group === GROUPS.ACTION_START || d.group === GROUPS.JUDGMENT_START)
    .map((d) => d.cause));
}

/** @param {readonly CauseDeclaration[]} declarations @returns {Readonly<Record<string, CauseProfile>>} */
export function profilesOf(declarations: readonly CauseDeclaration[]): Readonly<Record<string, CauseProfile>> {
  return Object.freeze(Object.fromEntries(declarations.map((d) => [d.cause, d.profile])));
}
