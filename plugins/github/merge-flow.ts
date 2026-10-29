// module: whether a repository has a merge flow (contract 1.25, A11-291) -- auto-merge allowed, and the arm workflow on its default branch
//
// AN APPROVED PULL REQUEST IN A REPOSITORY WITH NEITHER SITS UNTIL A PERSON MERGES IT (a11ign/plugin#10: approved at 91cfe96d, green, a day). A repository's flow is one of two: the repository must allow auto-merge for the arm to
// do anything and `.github/workflows/auto-arm.yml` is the bot that arms an approved pull request (A11-274); or, in a PRIVATE repository on a plan with no rulesets, `.github/workflows/merge-bot.yml` merges it itself (A11-291). The board reads this to say why an approved pull request is not merging, and doctor reads it for every repository of the host.
// ONE GRAPHQL CALL ANSWERS FOR ANY NUMBER OF REPOSITORIES (an alias each), because doctor's plugin checks run under a time limit and thirteen repositories at two REST reads each do not fit it. Read through an injected `run`
// (the plugin's `gh`), so this file spawns nothing.
import type { ARM_WORKFLOW_PATH as CONTRACT_ARM_WORKFLOW_PATH, MERGE_BOT_WORKFLOW_PATH as CONTRACT_MERGE_BOT_WORKFLOW_PATH, MergeFlow } from "../../src/plugins/contracts/code-host.ts";
import { type AsyncGh, GhFailure, type Gh } from "./gh.ts";

/** The arm workflow's path the contract names (`ARM_WORKFLOW_PATH`); a plugin imports core's types only, so the type holds it to the contract's spelling. */
export const ARM_WORKFLOW_PATH: typeof CONTRACT_ARM_WORKFLOW_PATH = ".github/workflows/auto-arm.yml";

/** The merge bot's path the contract names (`MERGE_BOT_WORKFLOW_PATH`), held to its spelling in the same way. */
export const MERGE_BOT_WORKFLOW_PATH: typeof CONTRACT_MERGE_BOT_WORKFLOW_PATH = ".github/workflows/merge-bot.yml";

/** The check the merge bot merges on (`.github/workflows/merge-bot.yml`'s `gate` job): in a repository whose flow is the merge bot, the one check the board waits on (A11-341). */
export const MERGE_BOT_GATE = "gate";

/** The query's selection of the merge bot's file on the default branch: null where the repository does not hold it. */
export const MERGE_BOT_FILE = `bot: object(expression: "HEAD:${MERGE_BOT_WORKFLOW_PATH}") { __typename }`;
/** The query's selection of the merge bot's file on pull request `number`'s head (`refs/pull/<n>/head`, which GitHub keeps for a fork's pull request too): null where the head does not hold it, as it does not when the pull request deletes it. */
const headMergeBotFile = (number: number): string => `headBot: object(expression: "refs/pull/${number}/head:${MERGE_BOT_WORKFLOW_PATH}") { __typename }`;
/** The fields that say whether a repository is private and holds the merge bot, on its default branch or on the head of pull request `number` (A11-344); a query asks them and {@link answerRunsMergeBot} reads the answer. */
export const mergeBotFields = (number: number): string => `isPrivate ${MERGE_BOT_FILE} ${headMergeBotFile(number)}`;

const holds = (file: unknown): boolean => file !== null && typeof file === "object";

/**
 * Whether a repository's merge flow is the merge bot, for a pull request: it is private, which GitHub Free offers no ruleset or merge queue, and the bot is on its default branch (A11-291) or on the pull request's head
 * (`headBot`, A11-344). The pull request that adds the bot is the first one it covers: the default branch holds nothing until that pull request merges.
 */
export const runsMergeBot = (flow: Pick<MergeFlow, "private" | "mergeBot"> & { headBot?: boolean }): boolean => flow.private && (flow.mergeBot || flow.headBot === true);

/** {@link runsMergeBot}, read off a GraphQL `repository` answer that asked for {@link mergeBotFields}: false when the answer does not say. */
export const answerRunsMergeBot = (repository: any): boolean => runsMergeBot({ private: repository?.isPrivate === true, mergeBot: holds(repository?.bot), headBot: holds(repository?.headBot) });

/** The query that asks whether pull request `number` of `parsed` holds the merge bot on its head. */
const headBotQuery = (parsed: { owner: string; name: string }, number: number): string => `query { r0: repository(owner: "${parsed.owner}", name: "${parsed.name}") { ${headMergeBotFile(number)} } }`;

const headHoldsBot = (data: Record<string, unknown> | null): boolean => holds((data?.r0 as { headBot?: unknown } | null | undefined)?.headBot);

/** Whether pull request `number` of `repository` (`owner/name`) holds the merge bot on its head: false when it does not, and when GitHub does not say (which is read as a head without the bot, so every check counts as before). */
export function readHeadHoldsMergeBot(repository: string, number: number, run: Gh): boolean {
  const parsed = repositoryOf(repository);
  if (parsed === null) return false;
  try {
    return headHoldsBot(dataOf(run, headBotQuery(parsed, number)));
  } catch {
    return false;
  }
}

/** {@link readHeadHoldsMergeBot} without holding the process still (A11-356). */
export async function readHeadHoldsMergeBotAsync(repository: string, number: number, run: AsyncGh): Promise<boolean> {
  const parsed = repositoryOf(repository);
  if (parsed === null) return false;
  try {
    return headHoldsBot(await dataOfAsync(run, headBotQuery(parsed, number)));
  } catch {
    return false;
  }
}

/** The owner and name of a repository written `owner/name`, or null for any other text (which also keeps a quote out of the query). */
function repositoryOf(repository: string): { owner: string; name: string } | null {
  const match = /^([^/\s"\\]+)\/([^/\s"\\]+)$/.exec(repository);
  return match === null ? null : { owner: match[1], name: match[2] };
}

/** What {@link readMergeFlows} asks of each repository: the setting, whether it is private, the default branch and whether its head holds the arm workflow (`object`) and the merge bot (`bot`), each null where the file is not. */
const FLOW_FIELDS = `autoMergeAllowed isPrivate defaultBranchRef { name } object(expression: "HEAD:${ARM_WORKFLOW_PATH}") { __typename } ${MERGE_BOT_FILE}`;

/** The query for the repositories: an alias `r<n>` each, asked `fields`. */
const queryOf = (repositories: readonly { owner: string; name: string }[], fields: string): string => `query { ${repositories.map(({ owner, name }, n) =>
  `r${n}: repository(owner: "${owner}", name: "${name}") { ${fields} }`).join(" ")} }`;

/** The answer's `data`, from the text `gh` printed, or null when it holds none. */
function dataIn(text: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(text)?.data;
    return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The answer's `data`, from the text `gh` printed: a repository GitHub could not read makes `gh` exit non-zero WITH the rest of the answer, so a failure that printed an answer is read too. Null when there is none. */
function dataOf(run: Gh, query: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = run(["api", "graphql", "-f", `query=${query}`]);
  } catch (error) {
    if (!(error instanceof GhFailure)) throw error;
    text = error.stdout;
  }
  return dataIn(text);
}

/** {@link dataOf} without holding the process still (A11-356). */
async function dataOfAsync(run: AsyncGh, query: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await run(["api", "graphql", "-f", `query=${query}`]);
  } catch (error) {
    if (!(error instanceof GhFailure)) throw error;
    text = error.stdout;
  }
  return dataIn(text);
}

/** One repository's answer as a merge flow, or null when it says neither whether auto-merge is allowed nor a default branch (a repository GitHub could not read). */
function flowOf(answer: any): MergeFlow | null {
  if (typeof answer?.autoMergeAllowed !== "boolean" || typeof answer.isPrivate !== "boolean" || typeof answer.defaultBranchRef?.name !== "string") return null;
  return { autoMerge: answer.autoMergeAllowed, armWorkflow: holds(answer.object), defaultBranch: answer.defaultBranchRef.name, private: answer.isPrivate, mergeBot: holds(answer.bot) };
}

/**
 * WHETHER EACH OF `repositories` CAN MERGE A PULL REQUEST BY ITSELF: it allows auto-merge, and its default branch holds the arm workflow. A repository maps to null for "could not ask": a name that is not `owner/name`, a repository
 * GitHub would not read, and an answer without the setting. Null is never "it has no flow". One call is made for all of them.
 */
export const readMergeFlows = (repositories: readonly string[], run: Gh): Readonly<Record<string, MergeFlow | null>> => readAliased(repositories, FLOW_FIELDS, flowOf, run);

/**
 * Each of `repositories` asked `fields` in one call, an alias each, and its answer read by `read`. A repository maps to null for "could not ask": a name that is not `owner/name` (never put in a query), a repository
 * GitHub would not read, an answer `read` refuses, and every one of them when the call fails.
 */
function readAliased<T>(repositories: readonly string[], fields: string, read: (answer: any) => T | null, run: Gh): Readonly<Record<string, T | null>> {
  const { named, none } = aliasesOf<T>(repositories);
  if (named.length === 0) return none;
  try {
    return answeredBy(named, none, dataOf(run, queryOf(named, fields)), read);
  } catch {
    return none;
  }
}

/** The repositories that are `owner/name`, with the parts, and the answer of each of `repositories` before any is read: null. */
function aliasesOf<T>(repositories: readonly string[]): { named: { repository: string; owner: string; name: string }[]; none: Record<string, T | null> } {
  const named = repositories.flatMap((repository) => {
    const parsed = repositoryOf(repository);
    return parsed === null ? [] : [{ repository, ...parsed }];
  });
  return { named, none: Object.fromEntries(repositories.map((repository): [string, T | null] => [repository, null])) };
}

/** Each named repository's alias in `data`, read by `read`; every repository is null where the call gave no `data`. */
function answeredBy<T>(named: readonly { repository: string }[], none: Record<string, T | null>, data: Record<string, unknown> | null, read: (answer: any) => T | null): Readonly<Record<string, T | null>> {
  return data === null ? none : { ...none, ...Object.fromEntries(named.map(({ repository }, n): [string, T | null] => [repository, read(data[`r${n}`])])) };
}

/** Whether one repository has a merge flow, as {@link readMergeFlows} reads it: null for "could not ask". */
export const readMergeFlow = (repository: string, run: Gh): MergeFlow | null => readMergeFlows([repository], run)[repository] ?? null;

/** {@link readMergeFlow} without holding the process still (A11-356). */
export async function readMergeFlowAsync(repository: string, run: AsyncGh): Promise<MergeFlow | null> {
  const { named, none } = aliasesOf<MergeFlow>([repository]);
  if (named.length === 0) return null;
  try {
    return answeredBy(named, none, await dataOfAsync(run, queryOf(named, FLOW_FIELDS)), flowOf)[repository] ?? null;
  } catch {
    return null;
  }
}

/**
 * A repository's merge flow as doctor's `merge flow` row reads it (A11-274): the contract's {@link MergeFlow}, and whether an active ruleset puts its default branch behind a merge queue (`mergeQueue`) and requires the
 * `gate` check (`gateRequired`). The board's card does not ask for these; the row does, since auto-merge and the arm workflow arm nothing in a repository with no merge queue.
 */
export type RepositoryFlow = MergeFlow & Readonly<{ mergeQueue: boolean; gateRequired: boolean }>;

/** One repository an organisation lists: its `owner/name`, whether it is archived, and its flow, or null where the answer does not say it. */
export type ListedRepository = Readonly<{ repository: string; archived: boolean; flow: RepositoryFlow | null }>;

/** The check every merge flow requires: the arm workflow's ruleset and the merge bot both merge on it. */
const GATE = "gate";

/** The most pages of an organisation's repositories one read asks for (100 each): doctor's plugin checks run under a time limit, so a larger organisation is not listed, and its cloned repositories are read by name. */
const MAX_PAGES = 5;

/** The query's selection of a repository's rulesets, with each rule's type and the checks a status-check rule requires. Rulesets the organisation applies to it are included, as GitHub enforces them too. GitHub charges a listing by these sizes (11 points a page at 10 and 20; 51 at 50 and 50). */
const RULESETS = "rulesets(first: 10) { nodes { enforcement rules(first: 20) { nodes { type parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } } } } } }";

/** What the row asks of each repository: {@link FLOW_FIELDS}, its name and whether it is archived, and its rulesets. */
const REPOSITORY_FIELDS = `name isArchived ${FLOW_FIELDS} ${RULESETS}`;

/** The rules of a repository's ACTIVE rulesets (one in evaluate mode or disabled enforces nothing). */
const activeRulesOf = (answer: any): any[] => (Array.isArray(answer?.rulesets?.nodes) ? answer.rulesets.nodes : [])
  .filter((ruleset: any) => ruleset?.enforcement === "ACTIVE")
  .flatMap((ruleset: any) => (Array.isArray(ruleset.rules?.nodes) ? ruleset.rules.nodes : []));

/** Whether an active rule requires the `gate` check. */
const requiresGate = (rules: readonly any[]): boolean => rules.some((rule) => rule?.type === "REQUIRED_STATUS_CHECKS"
  && Array.isArray(rule.parameters?.requiredStatusChecks) && rule.parameters.requiredStatusChecks.some((check: any) => check?.context === GATE));

/** One repository's answer as {@link REPOSITORY_FIELDS} asked it, or null when it says neither the setting nor whether it is private. An empty repository has no default branch, and is read with none, not as unread. */
function repositoryFlowOf(answer: any): RepositoryFlow | null {
  if (typeof answer?.autoMergeAllowed !== "boolean" || typeof answer.isPrivate !== "boolean") return null;
  const rules = activeRulesOf(answer);
  return {
    autoMerge: answer.autoMergeAllowed, armWorkflow: holds(answer.object), defaultBranch: typeof answer.defaultBranchRef?.name === "string" ? answer.defaultBranchRef.name : "", private: answer.isPrivate,
    mergeBot: holds(answer.bot), mergeQueue: rules.some((rule) => rule?.type === "MERGE_QUEUE"), gateRequired: requiresGate(rules),
  };
}

/** Whether `owner` is a login that is safe to put in a query (no slash, space, quote or backslash). */
const isOwner = (owner: string): boolean => /^[^/\s"\\]+$/.test(owner);

/** The query for one page of organisation `owner`'s repositories, after `after` (null for the first). */
const pageQuery = (owner: string, after: string | null): string =>
  `query { organization(login: "${owner}") { repositories(first: 100${after === null ? "" : `, after: ${JSON.stringify(after)}`}) { pageInfo { hasNextPage endCursor } nodes { ${REPOSITORY_FIELDS} } } } }`;

/** What one page of an organisation's listing says: the whole answer (`listed`), that GitHub finds no organisation by that login, that the listing cannot be read, or the repositories of this page and the cursor of the next (undefined on the last page). */
type Page = "not an organisation" | null | Readonly<{ listed: readonly ListedRepository[]; after: string | undefined }>;

/** The page in `data`, an answer of {@link pageQuery}. */
function pageOf(owner: string, data: Record<string, unknown> | null): Page {
  if (data !== null && data.organization === null) return "not an organisation";
  const repositories = (data?.organization as any)?.repositories;
  if (!Array.isArray(repositories?.nodes)) return null;
  const listed: ListedRepository[] = [];
  for (const node of repositories.nodes) {
    if (typeof node?.name !== "string") return null;
    listed.push({ repository: `${owner}/${node.name}`, archived: node.isArchived === true, flow: repositoryFlowOf(node) });
  }
  if (repositories.pageInfo?.hasNextPage !== true) return { listed, after: undefined };
  return typeof repositories.pageInfo.endCursor === "string" ? { listed, after: repositories.pageInfo.endCursor } : null;
}

/** The listing of an organisation written once, as steps: each yields the query for a page and is told the `data` that answered it (A11-395), so the synchronous and the asynchronous read below ask in their own way and judge alike. */
type PageSteps = Generator<string, readonly ListedRepository[] | "not an organisation" | null, Record<string, unknown> | null>;

function* organisationPages(owner: string): PageSteps {
  const listed: ListedRepository[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = pageOf(owner, yield pageQuery(owner, after));
    if (read === null || read === "not an organisation") return read;
    listed.push(...read.listed);
    if (read.after === undefined) return listed;
    after = read.after;
  }
  return null;
}

/**
 * EVERY REPOSITORY OF ORGANISATION `owner`, with its merge flow (A11-274), so a repository no clone and no list names is read too: a new one is listed the day it is made. One call per hundred repositories. "not an organisation"
 * where GitHub finds no organisation by that login (a user's account), and null where the listing could not be read whole: a page that failed is never read as a shorter list.
 */
export function readOrganisationFlows(owner: string, run: Gh): readonly ListedRepository[] | "not an organisation" | null {
  if (!isOwner(owner)) return null;
  const steps = organisationPages(owner);
  try {
    let next = steps.next();
    while (!next.done) next = steps.next(dataOf(run, next.value));
    return next.value;
  } catch {
    return null;
  }
}

/** {@link readOrganisationFlows} without holding the process still (A11-395): the pages are read one after the other. */
export async function readOrganisationFlowsAsync(owner: string, run: AsyncGh): Promise<readonly ListedRepository[] | "not an organisation" | null> {
  if (!isOwner(owner)) return null;
  const steps = organisationPages(owner);
  try {
    let next = steps.next();
    while (!next.done) next = steps.next(await dataOfAsync(run, next.value));
    return next.value;
  } catch {
    return null;
  }
}

/** One repository's answer as {@link REPOSITORY_FIELDS} asked it, with whether it is archived, or null when it says neither the setting nor whether it is private. */
function archivedFlowOf(answer: any): { archived: boolean; flow: RepositoryFlow } | null {
  const flow = repositoryFlowOf(answer);
  return flow === null ? null : { archived: answer.isArchived === true, flow };
}

/** What {@link readRepositoryFlows} makes of the answers `read` by name: each repository's listing, or null. */
const listedByName = (repositories: readonly string[], read: Readonly<Record<string, { archived: boolean; flow: RepositoryFlow } | null>>): Readonly<Record<string, ListedRepository | null>> =>
  Object.fromEntries(repositories.map((repository) => {
    const answer = read[repository] ?? null;
    return [repository, answer === null ? null : { repository, ...answer }];
  }));

/** {@link readOrganisationFlows}'s reading of each of `repositories` by name (`owner/name`), for an owner that is not an organisation: one call for all, and null for a repository that could not be read. */
export function readRepositoryFlows(repositories: readonly string[], run: Gh): Readonly<Record<string, ListedRepository | null>> {
  return listedByName(repositories, readAliased(repositories, REPOSITORY_FIELDS, archivedFlowOf, run));
}

/** {@link readRepositoryFlows} without holding the process still (A11-395). */
export async function readRepositoryFlowsAsync(repositories: readonly string[], run: AsyncGh): Promise<Readonly<Record<string, ListedRepository | null>>> {
  const { named, none } = aliasesOf<{ archived: boolean; flow: RepositoryFlow }>(repositories);
  if (named.length === 0) return listedByName(repositories, none);
  try {
    return listedByName(repositories, answeredBy(named, none, await dataOfAsync(run, queryOf(named, REPOSITORY_FIELDS)), archivedFlowOf));
  } catch {
    return listedByName(repositories, none);
  }
}
