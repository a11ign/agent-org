// @ts-check
// #2619 (child 3d of #69): THE PROJECT'S VOCABULARY -- the row template's field names and the label,
// milestone, lane-prefix and shared-resource words the machinery reads (ADR 0040, decision 1, surface 2).
// Read from `.agent-org/project.json`'s `vocabulary` key the same way `project-config.mjs` reads
// `tracker`/`code`: IT REFUSES, IT NEVER DEFAULTS. A missing or mistyped field is refused naming it, and
// a11ign's values are read back rather than assumed, so a second project can name its own.
//
// THE FOUR CLAIM-LIFECYCLE LABELS ARE DELIBERATELY NOT PARSED HERE. `claim-labels.mjs` is a pinned,
// import-free LEAF (`ready-label-audit.test.ts`, #804) precisely so nothing depending on it can form a
// cycle through `row-claim.mjs`'s rule-set graph. Moving `ready`/`was-ready`/`in-progress`/`started` into
// this file's own JSON read would mean either breaking that leaf's contract or stating the same four
// facts twice -- this module does neither: it imports them from their one owner and re-exports them
// beside the rest of the vocabulary, so a caller who needs all of it can still get all of it from here.
import { readFileSync } from "node:fs";
import { CLAIM_LABEL, READY_LABEL, STARTED_LABEL, WAS_READY_LABEL } from "./claim-labels.ts";
import { HOME_CHECKOUT, ProjectDeclarationRefusal } from "./project-config.ts";

export { CLAIM_LABEL, READY_LABEL, STARTED_LABEL, WAS_READY_LABEL };

const SOURCE = ".agent-org/project.json";

export type ResourcePattern = { pattern: RegExp, reason: string, named: boolean };
export type Labels = { backlog: string, needsChairman: string, outOfRelease: string, blocked: string };
export type Prefixes = { lane: string, session: string, answer: string };
export type Milestones = { roadToVersionOne: string, outOfRelease: string };
export type TemplateFields = { acceptance: string, closes: string, fleet: string };
export type Vocabulary = { labels: Labels, prefixes: Prefixes, milestones: Milestones, lanesFile: string, templateFields: TemplateFields, fleetQuestion: string, resources: ResourcePattern[] };

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const describe = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`);

/** @param {Record<string, unknown>} holder @param {string} name @param {string} path */
function requiredObject(holder: Record<string, unknown>, name: string, path: string) {
  if (!Object.hasOwn(holder, name)) throw new ProjectDeclarationRefusal(`${path}${name}`, "it is missing", SOURCE);
  const value = holder[name];
  if (!isObject(value)) throw new ProjectDeclarationRefusal(`${path}${name}`, `it must be an object, not ${describe(value)}`, SOURCE);
  return value;
}

/** @param {Record<string, unknown>} holder @param {string} name @param {string} path */
function requiredString(holder: Record<string, unknown>, name: string, path: string) {
  if (!Object.hasOwn(holder, name)) throw new ProjectDeclarationRefusal(`${path}${name}`, "it is missing", SOURCE);
  const value = holder[name];
  if (typeof value !== "string" || value === "") {
    throw new ProjectDeclarationRefusal(`${path}${name}`, `it must be a non-empty string, not ${describe(value)}`, SOURCE);
  }
  return value;
}

/**
 * `vocabulary.resources`: `FLEET_LAB_PATTERNS`' own values, moved out of `acceptance-commands.mjs`. An
 * ABSENT list reads as empty -- a project with no fleet or lab has none of its own, and adds to no floor
 * the tool enforces itself, because every entry here is a11ign's alone.
 * @param {Record<string, unknown>} vocabulary
 * @returns {ResourcePattern[]}
 */
function readResources(vocabulary: Record<string, unknown>): ResourcePattern[] {
  if (!Object.hasOwn(vocabulary, "resources")) return [];
  const list = vocabulary.resources;
  if (!Array.isArray(list)) {
    throw new ProjectDeclarationRefusal("vocabulary.resources", `it must be a list, not ${describe(list)}`, SOURCE);
  }
  return list.map((entry, index) => {
    const at = `vocabulary.resources[${index}]`;
    if (!isObject(entry)) throw new ProjectDeclarationRefusal(at, `it must be an object, not ${describe(entry)}`, SOURCE);
    const pattern = requiredString(entry, "pattern", `${at}.`);
    const reason = requiredString(entry, "reason", `${at}.`);
    const named = Object.hasOwn(entry, "named") ? entry.named : false;
    if (typeof named !== "boolean") throw new ProjectDeclarationRefusal(`${at}.named`, `it must be a boolean, not ${describe(named)}`, SOURCE);
    try {
      return { pattern: new RegExp(pattern), reason, named };
    } catch (cause) {
      throw new ProjectDeclarationRefusal(`${at}.pattern`, "it is not a regular expression", SOURCE, { cause });
    }
  });
}

/**
 * Parse the `vocabulary` key of an already-`JSON.parse`d `.agent-org/project.json`. PURE: a test drives
 * every refusal with a plain object, the discipline `parseProjectDeclaration` holds itself to.
 * @param {unknown} parsed the whole parsed JSON document
 * @returns {Readonly<Vocabulary>}
 */
export function parseVocabulary(parsed: unknown): Readonly<Vocabulary> {
  if (!isObject(parsed)) throw new ProjectDeclarationRefusal("(file)", `it must be a JSON object, not ${describe(parsed)}`, SOURCE);
  const vocabulary = requiredObject(parsed, "vocabulary", "");
  const labels = requiredObject(vocabulary, "labels", "vocabulary.");
  const prefixes = requiredObject(vocabulary, "prefixes", "vocabulary.");
  const milestones = requiredObject(vocabulary, "milestones", "vocabulary.");
  const templateFields = requiredObject(vocabulary, "templateFields", "vocabulary.");
  return Object.freeze({
    labels: Object.freeze({
      backlog: requiredString(labels, "backlog", "vocabulary.labels."),
      needsChairman: requiredString(labels, "needsChairman", "vocabulary.labels."),
      outOfRelease: requiredString(labels, "outOfRelease", "vocabulary.labels."),
      blocked: requiredString(labels, "blocked", "vocabulary.labels."),
    }),
    prefixes: Object.freeze({
      lane: requiredString(prefixes, "lane", "vocabulary.prefixes."),
      session: requiredString(prefixes, "session", "vocabulary.prefixes."),
      answer: requiredString(prefixes, "answer", "vocabulary.prefixes."),
    }),
    milestones: Object.freeze({
      roadToVersionOne: requiredString(milestones, "roadToVersionOne", "vocabulary.milestones."),
      outOfRelease: requiredString(milestones, "outOfRelease", "vocabulary.milestones."),
    }),
    lanesFile: requiredString(vocabulary, "lanesFile", "vocabulary."),
    templateFields: Object.freeze({
      acceptance: requiredString(templateFields, "acceptance", "vocabulary.templateFields."),
      closes: requiredString(templateFields, "closes", "vocabulary.templateFields."),
      fleet: requiredString(templateFields, "fleet", "vocabulary.templateFields."),
    }),
    fleetQuestion: requiredString(vocabulary, "fleetQuestion", "vocabulary."),
    resources: readResources(vocabulary),
  });
}

let cached: Readonly<Vocabulary> | undefined;

/** The a11ign vocabulary, read once from `.agent-org/project.json` at `HOME_CHECKOUT`. @returns {Readonly<Vocabulary>} */
export function homeVocabulary(): Readonly<Vocabulary> {
  if (cached === undefined) {
    const path = `${HOME_CHECKOUT}/${SOURCE}`;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      throw new ProjectDeclarationRefusal("(file)", "the declaration cannot be read", path, { cause });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new ProjectDeclarationRefusal("(file)", "it is not valid JSON", path, { cause });
    }
    cached = parseVocabulary(parsed);
  }
  return cached;
}

const vocabulary = homeVocabulary();

export const BACKLOG_LABEL = vocabulary.labels.backlog;
export const NEEDS_CHAIRMAN_LABEL = vocabulary.labels.needsChairman;
export const OUT_OF_RELEASE_LABEL = vocabulary.labels.outOfRelease;
export const BLOCKED_LABEL = vocabulary.labels.blocked;
export const LANE_PREFIX = vocabulary.prefixes.lane;
/** `lane:any`: the sentinel `laneLabelsFor` (`row-file.mjs`) assigns when a Region touches no lane's
 * paths -- CODE'S OWN answer, never a value `docs/lane-ownership.json` declares, so it is a constant
 * built from the prefix rather than a sixth field. */
export const LANE_ANY_LABEL = `${LANE_PREFIX}any`;
export const SESSION_PREFIX = vocabulary.prefixes.session;
export const ANSWER_PREFIX = vocabulary.prefixes.answer;
export const ROAD_TO_VERSION_ONE_MILESTONE = vocabulary.milestones.roadToVersionOne;
export const OUT_OF_RELEASE_MILESTONE = vocabulary.milestones.outOfRelease;
export const LANES_FILE_PATH = vocabulary.lanesFile;
export const ACCEPTANCE_FIELD = vocabulary.templateFields.acceptance;
export const CLOSES_FIELD = vocabulary.templateFields.closes;
export const FLEET_FIELD = vocabulary.templateFields.fleet;
export const FLEET_QUESTION = vocabulary.fleetQuestion;
export const RESOURCES = vocabulary.resources;
