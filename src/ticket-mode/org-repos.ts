// @ts-check
// module: the organisation's repositories, and the clone of one this machine does not have yet (A11-355)
//
// A TICKET IS NOT LIMITED TO WHAT THE HOST HAS CLONED. The host file's `clones` was kept by hand, so work that belonged in a repository nobody had cloned could not be planned into it, and ended `wrong-repo`
// on a person (A11-351). The organisation is the machine's own repositories' owner: the owners of the `origin` remotes of its clones. Its repositories are listed live, archived ones left out, by the code host's
// `repositories` group, as the account the board acts as (the workers'), and a repository a plan or a worker names is cloned beside the others when it is in that list.
//
// THE CLONE IS THE SAME AS THE EXISTING ONES: the repository's https address as `origin`, with the credentials the host's git already uses for the workers (the credential helper of its global git config, which `host:check`
// holds in place), cloned beside the existing clones and added to the host file's `clones` under the repository's name. A name the host file already holds is never touched.
//
// THE READS ARE SYNCHRONOUS, AS THE CODE HOST'S ARE; ONLY THE CLONE IS NOT, so the board keeps answering while a large repository comes down.
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CodeHost, HostRepository } from "../plugins/contracts/code-host.ts";
import { spliceJson } from "./json-edit.ts";
import type { Git } from "./worktree.ts";

type Clones = Readonly<Record<string, string>>;

/** A repository name a folder can be made from: no path separators, and not a name that starts with a dot (the folder of `.github` is `github`). */
const FOLDER = /^[A-Za-z0-9][\w.-]*$/;

/** The repositories of the organisation, live and not archived, or why they could not be read. */
export type OrgReading = Readonly<{ repositories: readonly HostRepository[] }> | Readonly<{ unreadable: string }>;

/** `origin` of the checkout at `path`, as the code host names its repository, or null: not a main checkout, no `origin`, or another host's address. Reads `.git/config`, so it starts no process. */
function originOf(path: string, codeHost: CodeHost): HostRepository | null {
  try {
    const config = readFileSync(join(path, ".git", "config"), "utf8");
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1];
    return url === undefined ? null : codeHost.repositories?.repositoryOfRemote(url) ?? null;
  } catch {
    return null;
  }
}

/** The repository each clone is of, by the host file's key for it. A clone that is not a main checkout of the code host's repository has none. */
const originsOf = (clones: Clones, codeHost: CodeHost): ReadonlyMap<string, HostRepository> =>
  new Map(Object.entries(clones).flatMap(([key, path]) => { const origin = originOf(path, codeHost); return origin === null ? [] : [[key, origin] as const]; }));

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The organisations the machine's clones belong to: the owners of their `origin` remotes, in the order the clones are listed. An owner of a single clone is one only when it is the only owner: a clone of a person's fork beside
 * the organisation's own does not make the person's account an organisation whose every repository the board would clone.
 */
export function ownersOf(clones: Clones, codeHost: CodeHost): readonly string[] {
  const owners = [...originsOf(clones, codeHost).values()].map(({ fullName }) => fullName.split("/")[0]);
  const once = owners.filter((owner, at) => owners.findIndex((other) => same(other, owner)) === at);
  const clonesOf = (owner: string): number => owners.filter((other) => same(other, owner)).length;
  const several = once.filter((owner) => clonesOf(owner) > 1);
  return once.length > 1 && several.length > 0 ? several : once;
}

/**
 * Every live repository of the organisations the machine's clones belong to. Unreadable, with the reason, when the code host lists none, there is no clone to name an organisation, or a list could not be read: a
 * caller never takes that for "the organisation has no more repositories".
 */
export function readOrganisation(clones: Clones, codeHost: CodeHost): OrgReading {
  const listing = codeHost.repositories;
  if (listing === undefined) return { unreadable: "the code host lists no repositories" };
  const owners = ownersOf(clones, codeHost);
  if (owners.length === 0) return { unreadable: "no clone names the organisation: none has an origin the code host knows" };
  const lists = owners.map((login) => listing.readRepositories({ login, kind: "organisation" }));
  const failed = owners.find((_owner, at) => lists[at] === null);
  if (failed !== undefined) return { unreadable: `the repositories of ${failed} could not be listed` };
  return { repositories: lists.flatMap((list) => list ?? []) };
}

/**
 * The key the host file holds the repository under, or null when it holds no clone of it: its name, unless that key's clone says it is another repository, else the key of a clone whose origin is it (a repository the host calls
 * `main-app` is the clone of `acme/web`).
 */
export function cloneKeyOf(repository: HostRepository, clones: Clones, codeHost: CodeHost): string | null {
  const origins = originsOf(clones, codeHost);
  const named = origins.get(repository.name);
  if (Object.hasOwn(clones, repository.name) && (named === undefined || same(named.fullName, repository.fullName))) return repository.name;
  for (const [key, origin] of origins) if (same(origin.fullName, repository.fullName)) return key;
  return null;
}

/** The repositories of `live` that the host file holds no clone of. */
export function unclonedOf(live: readonly HostRepository[], clones: Clones, codeHost: CodeHost): readonly HostRepository[] {
  return live.filter((repository) => cloneKeyOf(repository, clones, codeHost) === null);
}

/**
 * The live repository a worker's `where` names: `owner/name` or a repository's address as its first word (`acme/corpus: the code lives there`), or a bare name that is the whole of it or ends before a colon (`corpus`, `corpus: the
 * code lives there`), which must be one repository's name in the list or the key of a clone. A sentence that merely starts with a repository's name (`Control plane belongs to another team`) names none. Null for a name no live repository
 * has: archived, outside the organisation or unknown.
 */
export function namedIn(text: string, live: readonly HostRepository[], clones: Clones, codeHost: CodeHost): HostRepository | null {
  const word = text.trim().split(/\s+/)[0]?.replace(/[:;,.]+$/, "") ?? "";
  const fullName = /(?:^|\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(word)?.[1];
  if (fullName !== undefined) return live.find((repository) => same(repository.fullName, fullName)) ?? null;
  const bare = /^([\w.-]+)\s*(?::|$)/.exec(text.trim())?.[1];
  if (bare === undefined) return null;
  return live.find((repository) => repository.name === bare) ?? live.find((repository) => same(repository.name, bare)) ?? liveCloneKeyed(bare, live, clones, codeHost);
}

/** The live repository the clone held under `key` (in any case) is of, or null: the key is no clone's, or its origin is not in the list. */
function liveCloneKeyed(key: string, live: readonly HostRepository[], clones: Clones, codeHost: CodeHost): HostRepository | null {
  const held = Object.keys(clones).find((candidate) => same(candidate, key));
  const origin = held === undefined ? undefined : originsOf(clones, codeHost).get(held);
  return origin === undefined ? null : live.find((repository) => same(repository.fullName, origin.fullName)) ?? null;
}

/** The folder the machine keeps its clones in: the one most of them are in, the first listed on a tie. Null with no clone. */
export function cloneRoot(clones: Clones): string | null {
  const parents = Object.values(clones).map((path) => dirname(path));
  const count = (parent: string): number => parents.filter((other) => other === parent).length;
  return parents.reduce<string | null>((best, parent) => (best === null || count(parent) > count(best) ? parent : best), null);
}

/** The https address `git clone` takes for the repository: the form of the existing clones' `origin`. */
export const remoteOf = (repository: HostRepository): string => `https://github.com/${repository.fullName}.git`;

/**
 * Adds `name` -> `path` to the `clones` of the host file at `hostFile`, as a splice that keeps every other byte, written whole beside the file and renamed over it. A host file that is a link is written where the link points, so the link
 * stays one.
 */
export function addCloneToHostFile(hostFile: string, name: string, path: string): void {
  const real = realpathSync(hostFile);
  const next = spliceJson(readFileSync(real, "utf8"), [{ path: ["clones", name], value: path }]);
  const temporary = `${real}.${process.pid}.tmp`;
  writeFileSync(temporary, next, { mode: statSync(real).mode & PERMISSION_BITS });
  renameSync(temporary, real);
}

/** What the board needs to clone a repository: the machine's clones as a mutable record the pool's settings share, the host file to record it in, `git`, and how long a clone may take. */
export type CloneSeams = Readonly<{ clones: Record<string, string>; hostFile: string | undefined; codeHost: CodeHost; git: Git; timeoutMs?: number }>;

const MS_PER_SECOND = 1000;
/** The permission bits of a file's mode, without its type. */
const PERMISSION_BITS = 0o777;
const spanWords = (ms: number): string => (ms >= MS_PER_SECOND ? `${Math.round(ms / MS_PER_SECOND)} seconds` : `${ms} ms`);

/** How long one clone may run before the board stops waiting for it: a stalled network must not hold a run, a Retry and the sweep for ever. */
export const CLONE_TIMEOUT_MS = 600_000;

/** The staging folders a `git clone` is still writing to, until that git process has ended: a clone the board stopped waiting for is still running, and a second clone must not start in its folder. */
const cloningNow = new Set<string>();

/** `work`, or a rejection once `ms` have passed. The work is not stopped: see {@link cloneIntoStaging}. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`${what} took more than ${spanWords(ms)}`)); }, ms); });
  return Promise.race([work, limit]).finally(() => { clearTimeout(timer); });
}

/**
 * Clones `repository` into `staging` and renames it to `path` once git is done. The board stops WAITING for a clone after `timeoutMs`, but cannot stop git, so the folder stays taken ({@link cloningNow}) until the git process itself ends, and
 * a clone abandoned that way is cleared then, never under the process. A second clone of the same repository meanwhile is refused, not started beside the first. THROWS with the reason.
 */
async function cloneIntoStaging(repository: HostRepository, { root, staging, path, git, timeoutMs }: Readonly<{ root: string; staging: string; path: string; git: Git; timeoutMs: number }>): Promise<void> {
  if (cloningNow.has(staging)) throw new Error(`${repository.fullName} cannot be cloned: an earlier clone of it is still running`);
  cloningNow.add(staging);
  rmSync(staging, { recursive: true, force: true });
  let abandoned = false;
  const work = git(root, ["clone", "--quiet", remoteOf(repository), staging]);
  // Cleared before the folder is released, so a clone started the moment it is released finds it empty.
  void work.then(() => undefined, () => undefined).then(() => {
    if (abandoned) rmSync(staging, { recursive: true, force: true });
    cloningNow.delete(staging);
  });
  try {
    await within(work, timeoutMs, `the clone of ${repository.fullName}`);
    renameSync(staging, path);
  } catch (err) {
    abandoned = true;
    throw err;
  }
}

/**
 * The key `repository` is held under, cloning it first when the host file holds no clone of it: into a staging folder beside the others, renamed to the repository's folder once git is done (a clone cut short by a restart leaves only
 * the staging folder, which is never taken for a clone), then recorded in the host file and in `clones`. THROWS with the reason when it cannot (a name no folder can be made from, a folder that is taken by something else, no folder to
 * clone into, a clone that git refuses or that takes too long, a host file that cannot be written). A clone made and then not recorded is found by its folder by the next call, which records it.
 */
export async function ensureCloned(repository: HostRepository, { clones, hostFile, codeHost, git, timeoutMs = CLONE_TIMEOUT_MS }: CloneSeams): Promise<string> {
  const held = cloneKeyOf(repository, clones, codeHost);
  if (held !== null) return held;
  const folder = repository.name.replace(/^\.+/, "");
  const root = cloneRoot(clones);
  if (!FOLDER.test(folder) || basename(folder) !== folder) throw new Error(`${repository.fullName} cannot be cloned: ${JSON.stringify(repository.name)} is not a name a folder can be made from`);
  if (root === null) throw new Error(`${repository.fullName} cannot be cloned: the host file holds no clone to say where this machine keeps them`);
  if (hostFile === undefined) throw new Error(`${repository.fullName} cannot be cloned: the board does not know its host file, so it could not record the clone`);
  const path = join(root, folder);
  if (existsSync(path)) {
    // A folder an earlier clone made and the host file never got: it is this repository's when its origin says so, and it is never cloned over.
    const origin = originOf(path, codeHost);
    if (origin === null || !same(origin.fullName, repository.fullName)) throw new Error(`${repository.fullName} cannot be cloned: ${path} exists and is not a clone of it`);
  } else {
    await cloneIntoStaging(repository, { root, staging: join(root, `.${folder}.cloning`), path, git, timeoutMs });
  }
  addCloneToHostFile(hostFile, repository.name, path);
  clones[repository.name] = path;
  return repository.name;
}
