// module: the onboard profile -- a saved answer file that `onboard --profile` reads, and writes when a person answers its questions (A11-145)
//
// A PROFILE IS A SAVED ANSWER FILE (A11-143 Decision 2). It is plain JSON with NO SECRET in it: the Linear key and the reviewer App's key are asked for, or
// read from where the OS keeps them. It is copyable to another machine, and it is never shipped in this repository: no company's or machine's profile
// appears here, and the tests use invented names. `--profile <name>` names `<AGENT_ORG_HOME>/profiles/<name>.json`; a value with a `/` is a path.
//
// Each block of the profile names its provider, as `tickets.providers` does (A11-144), and carries that provider's settings beside it, so onboard copies
// the block into the host file and the host reader checks it there. What onboard adds is what the profile cannot hold: the key's place, the App's key file.
//
// A BLOCK'S PROVIDER IS AN AGENT-ORG PLUGIN OF ITS CONCERN (A11-163): any bundled plugin the registry holds for it, not a fake and not one core is pinned off, plus `none` for a
// publisher or reviewer. The list is the catalog's, not a list written here, so a plugin that is added to the registry can be named by a profile with no change to this file. A profile
// keeps schema 1 and its block shape, so one saved before still reads. Messaging is no profile key: it is configured in a project's `project.json`, which a ticket-only laptop has none of.
import { isAbsolute, join } from "node:path";
import type { ProviderBlock } from "../plugins/concerns.ts";
import type { Catalog } from "../plugins/manifest.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { choosable } from "../ticket-mode/providers.ts";
import { agentOrgHome, type Env } from "./paths.ts";

export const PROFILE_SCHEMA = 1;

/** A provider's block as the profile holds it: its provider's name, and its settings beside it. */
export type ProfileBlock = Readonly<{ provider: string } & Record<string, unknown>>;

/** The reviewer App a profile names: its slug as its page on GitHub names it, its id, and the installation the key mints tokens for. */
export type ReviewerApp = Readonly<{ slug: string; appId: number; installationId: number }>;

/** A repository a worker can choose from: its clone's name, its GitHub `owner/repo` (to clone it when it is missing), and where its checkout is. */
export type ProfileRepo = Readonly<{ name: string; remote?: string; path: string }>;

export type Profile = Readonly<{
  schema: typeof PROFILE_SCHEMA;
  tracker: ProfileBlock;
  codeHost: ProfileBlock;
  publish: ProfileBlock;
  reviewer: ProfileBlock;
  exposure: ProfileBlock;
  /** The conventions plugin a worker's session loads, as `name@marketplace`, and the GitHub repository its marketplace is in. */
  conventions?: Readonly<{ plugin: string; marketplace: string; prReview?: boolean }>;
  repos: readonly ProfileRepo[];
  /** Markdown files copied to the house notes instead of the ones agent-org ships, so an organisation's own rules travel with the profile. */
  notes?: Readonly<{ worker?: string; review?: string }>;
}>;

/** A profile that is not one onboard can use, refused by the field it names. */
export class ProfileRefusal extends Error {}

const TOP_KEYS = ["schema", "tracker", "codeHost", "publish", "reviewer", "exposure", "conventions", "repos", "notes"] as const;
const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;
const PLUGIN = /^[\w.-]+@[\w.-]+$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The profile's path: `<AGENT_ORG_HOME>/profiles/<name>.json` for a name, the path itself for one with a `/` (`~` expanded). */
export function profilePathOf(profile: string, env: Env, home: string): string {
  if (!profile.includes("/")) {
    if (!PROFILE_NAME.test(profile)) throw new ProfileRefusal(`--profile ${profile}: a profile's name is letters, digits, \`.\`, \`_\` and \`-\`, or a path with a \`/\` in it`);
    return join(agentOrgHome(env, home), "profiles", `${profile}.json`);
  }
  const path = profile === "~" || profile.startsWith("~/") ? join(home, profile.slice(1)) : profile;
  if (!isAbsolute(path)) throw new ProfileRefusal(`--profile ${profile}: a profile given as a path must be an absolute path`);
  return path;
}

/** The profile's text, as a person can copy it: two-space JSON, with no secret in it. */
export const profileText = (profile: Profile): string => `${JSON.stringify(profile, null, 2)}\n`;

/** The plugins a profile's block may name: the catalog's for the block's concern (`providers.ts` names the same), and `none` where a concern may have no plugin. */
const providersOf = (name: ProviderBlock, catalog: Catalog): readonly string[] => choosable(name, catalog);

function block(value: unknown, field: string, providers: readonly string[]): ProfileBlock {
  if (!isObject(value)) throw new ProfileRefusal(`${field} must be an object with a provider, such as { "provider": "${providers[0]}" }`);
  if (typeof value.provider !== "string" || !providers.includes(value.provider)) {
    throw new ProfileRefusal(`${field}.provider must be one of ${providers.map((name) => `"${name}"`).join(", ")}, not ${JSON.stringify(value.provider)}`);
  }
  return value as ProfileBlock;
}

function repoOf(value: unknown, index: number): ProfileRepo {
  const field = `repos[${index}]`;
  if (!isObject(value) || typeof value.name !== "string" || !REPO_NAME.test(value.name)) {
    throw new ProfileRefusal(`${field}.name is a clone's name: letters, digits, \`.\`, \`_\` and \`-\``);
  }
  if (typeof value.path !== "string" || value.path === "") throw new ProfileRefusal(`${field}.path is the checkout's path, such as "~/repos/<dir>"`);
  if (value.remote !== undefined && (typeof value.remote !== "string" || !REPOSITORY.test(value.remote))) {
    throw new ProfileRefusal(`${field}.remote is the repository as owner/repo, such as "<owner>/<repo>"`);
  }
  return { name: value.name, path: value.path, ...(value.remote === undefined ? {} : { remote: value.remote }) };
}

function reviewerAppOf(value: unknown): ReviewerApp | undefined {
  if (value === undefined) return undefined;
  const at = "codeHost.reviewerApp";
  if (!isObject(value) || typeof value.slug !== "string" || value.slug === "") throw new ProfileRefusal(`${at}.slug is the App's slug, as its page on GitHub names it`);
  for (const key of ["appId", "installationId"] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) <= 0) throw new ProfileRefusal(`${at}.${key} is the id GitHub issued: a positive whole number`);
  }
  return { slug: value.slug, appId: value.appId as number, installationId: value.installationId as number };
}

/** The code host's block, with its reviewer App checked when it names one. */
function codeHostOf(value: unknown, catalog: Catalog): ProfileBlock {
  const checked = block(value, "codeHost", providersOf("codeHost", catalog));
  reviewerAppOf(checked.reviewerApp);
  return checked;
}

function conventionsOf(value: unknown): Profile["conventions"] {
  if (value === undefined) return undefined;
  if (!isObject(value) || typeof value.plugin !== "string" || !PLUGIN.test(value.plugin)) {
    throw new ProfileRefusal("conventions.plugin is the plugin as name@marketplace, such as \"<name>@<marketplace>\"");
  }
  if (typeof value.marketplace !== "string" || !REPOSITORY.test(value.marketplace)) {
    throw new ProfileRefusal("conventions.marketplace is the GitHub repository the plugin's marketplace is in, as owner/repo");
  }
  if (value.prReview !== undefined && typeof value.prReview !== "boolean") throw new ProfileRefusal("conventions.prReview must be true or false");
  return { plugin: value.plugin, marketplace: value.marketplace, ...(value.prReview === undefined ? {} : { prReview: value.prReview }) };
}

function notesOf(value: unknown): Profile["notes"] {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new ProfileRefusal("notes must be an object of the markdown files it copies, such as { \"worker\": \"<path>\" }");
  for (const key of Object.keys(value)) {
    if (key !== "worker" && key !== "review") throw new ProfileRefusal(`notes.${key} is not a note: the notes are worker and review`);
    if (typeof value[key] !== "string" || !isAbsolute(value[key] as string)) throw new ProfileRefusal(`notes.${key} must be an absolute path`);
  }
  return value as Profile["notes"];
}

/**
 * The profile, from its text. Refused by the field it names: an unknown key, a provider that is not one of its concern's, and a repository with no
 * name or path. PURE: the caller reads the file, and names it in the refusal it prints.
 */
export function parseProfile(text: string, catalog: Catalog = defaultCatalog()): Profile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProfileRefusal(`is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(parsed)) throw new ProfileRefusal("must be a JSON object");
  for (const key of Object.keys(parsed)) {
    if (!(TOP_KEYS as readonly string[]).includes(key)) throw new ProfileRefusal(`${key} is not a profile key: the keys are ${TOP_KEYS.join(", ")}`);
  }
  if (parsed.schema !== PROFILE_SCHEMA) throw new ProfileRefusal(`schema must be ${PROFILE_SCHEMA}, the one this release reads`);
  if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) throw new ProfileRefusal("repos must list at least one repository, as { \"name\", \"remote\", \"path\" }");
  return {
    schema: PROFILE_SCHEMA,
    tracker: block(parsed.tracker, "tracker", providersOf("tracker", catalog)),
    codeHost: codeHostOf(parsed.codeHost, catalog),
    publish: block(parsed.publish, "publish", providersOf("publish", catalog)),
    reviewer: block(parsed.reviewer, "reviewer", providersOf("reviewer", catalog)),
    exposure: block(parsed.exposure, "exposure", providersOf("exposure", catalog)),
    ...(parsed.conventions === undefined ? {} : { conventions: conventionsOf(parsed.conventions) }),
    repos: parsed.repos.map(repoOf),
    ...(parsed.notes === undefined ? {} : { notes: notesOf(parsed.notes) }),
  };
}

/** The plugins a question offers for a block, as the question words them: the catalog's, in its order, `none` last. */
const choicesOf = (name: ProviderBlock, catalog: Catalog): string => providersOf(name, catalog).join(" or ");

/** The questions onboard asks when a profile is absent, with the answer each takes by default. */
export type ProfileAnswers = Readonly<{ ask: (question: string) => Promise<string> }>;

/**
 * The profile a person answers at a terminal: the team whose tickets the Pick view lists, the conventions plugin and its marketplace, the publisher, the
 * reviewer and its GitHub App's identity, the exposure. Each question says its default and takes it on an empty answer. The App's key is NOT asked here:
 * it is a secret, asked for when the host file is written.
 */
export async function askProfile({ ask }: ProfileAnswers, repos: readonly ProfileRepo[], catalog: Catalog = defaultCatalog()): Promise<Profile> {
  const answer = async (question: string, fallback: string) => {
    const text = (await ask(`${question} [${fallback}]: `)).trim();
    return text === "" ? fallback : text;
  };
  const team = await answer("Team key whose tickets the Pick view lists, such as A11 (or \"assigned\" for only the ones assigned to you)", "assigned");
  const plugin = await answer("Conventions plugin as name@marketplace (or \"none\")", "none");
  const reviewer = await answer(`Reviewer: ${choicesOf("reviewer", catalog)}`, "atomic");
  const publisher = await answer("Publisher: none", "none");
  if (publisher !== "none") throw new ProfileRefusal("publish: onboard asks only for none; a Slack publisher is written into the profile file by hand, with its run");
  const exposure = await answer(`Exposure: ${choicesOf("exposure", catalog)}`, "local");
  // The App is asked for only when a slug is given: the verdict posts through it, and an empty slug leaves that to a later profile.
  const slug = reviewer === "atomic" ? await answer("The reviewer's GitHub App slug, as its page on GitHub names it (or an empty line to set it later)", "") : "";
  const reviewerApp = slug === "" ? undefined : {
    slug,
    appId: Number(await answer("The reviewer's GitHub App id", "0")),
    installationId: Number(await answer("The reviewer's App installation id", "0")),
  };
  const conventions = plugin === "none" ? undefined : {
    plugin,
    marketplace: await answer(`The GitHub repository of the marketplace ${plugin.split("@")[1] ?? ""}, as owner/repo`, ""),
  };
  return parseProfile(JSON.stringify({
    schema: PROFILE_SCHEMA,
    tracker: { provider: "linear", ...(team === "assigned" ? {} : { pick: { team } }) },
    codeHost: { provider: "github", ...(reviewerApp === undefined ? {} : { reviewerApp }) },
    publish: { provider: publisher },
    reviewer: { provider: reviewer },
    exposure: { provider: exposure },
    ...(conventions === undefined ? {} : { conventions }),
    repos,
  }), catalog);
}

/**
 * The provider blocks a profile names, as the host file holds them, and the two keys that sit beside them: `pick` (under `tickets`) and the reviewer App's
 * identity. A profile's block is copied as it is, so the host reader checks each setting under the name the profile wrote; a plugin's own defaults (a tailscale
 * exposure's ports) are written by that plugin's onboard step (A11-162). PURE.
 */
export function providerBlocksOf(profile: Profile): Readonly<{
  tracker: Record<string, unknown>; codeHost: Record<string, unknown>; publish: Record<string, unknown>; reviewer: Record<string, unknown>; exposure: Record<string, unknown>;
  pick: unknown; reviewerApp: ReviewerApp | undefined;
}> {
  const { pick, ...tracker } = profile.tracker;
  const { reviewerApp, ...codeHost } = profile.codeHost;
  return { tracker, codeHost, publish: profile.publish, reviewer: profile.reviewer, exposure: profile.exposure, pick, reviewerApp: reviewerApp as ReviewerApp | undefined };
}
