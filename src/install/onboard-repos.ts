// module: onboard's repository step at a terminal (A11-186) -- the checkouts in the folder onboard runs in, then, if the person wants more, the code host's organisations and repositories, cloned where they are missing
//
// STEP 1 ASKS NOTHING FIRST. The folder onboard runs in (people run it from the folder that holds their checkouts) is scanned: the folder itself and each folder one level down, minus names that start with `.` and
// `node_modules`. A MAIN CHECKOUT (its `.git` is a directory) is read from its `.git/config` -- `origin` first, then the other remotes -- and the code host's own `repositoryOfRemote` says which repository the remote
// is, so the scan stays inside the contract, starts no process and needs no sign-in. A linked worktree (its `.git` is a file) shares its main checkout's remote and is skipped. What it finds is shown pre-ticked,
// named as the code host names it.
//
// STEP 2 IS OPTIONAL: "Add repositories not cloned here?". The code host lists the signed-in account and its organisations, then the repositories of those ticked; each ticked repository without a checkout is
// offered for cloning, with the command shown, into a folder that starts as the folder onboard runs in.
//
// THE HOST FILE'S CLONES ARE KEPT. A name the host file already holds keeps its path whatever is ticked, and is never removed (onboard writes only the keys that are absent); the host file's repositories are pre-ticked.
// A NEW NAME IS THE CODE HOST'S: `repoOfProject` matches a Linear project's repository against the names (A11-70). The host file names a repository once, so two ticked repositories with one name are asked again.
//
// IT PRINTS A SUMMARY before onboard writes anything: each repository, its path, and found, cloned or kept. A list the code host cannot give is said, and onboard falls back to the typed prompt when nothing was found.
import { basename, isAbsolute, join, resolve } from "node:path";
import type { CodeHostRepositories, HostRepository, RepositoryOwner } from "../plugins/contracts/code-host.ts";
import type { Choice, Prompts } from "./prompts.ts";

export type PickerDeps = Readonly<{
  /** The folder onboard runs in. */
  cwd: string;
  home: string;
  repositories: CodeHostRepositories;
  prompts: Prompts;
  out: Pick<Console, "log">;
  isDirectory: (path: string) => boolean;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** The names in a directory, or [] when it cannot be read. */
  listDir: (path: string) => string[];
}>;

/** A repository the person picked: the name the host file holds it under, where it is checked out, and the code host's `owner/name`. */
export type PickedRepository = Readonly<{ name: string; path: string; fullName: string }>;

/** One line of the summary: what the host file will hold under `name`, or why a repository is left out of it. */
type Row = Readonly<{ name: string; path: string; fullName: string | null; ok: boolean; how: string; picked: boolean }>;

/** A main checkout the scan found and the repository its remote names. */
type Checkout = Readonly<{ repository: HostRepository; path: string }>;

type Held = Readonly<Record<string, string>>;

const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(["node_modules"]);
const KEPT = "kept: already in the host file";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The repositories the code host's remote URLs in a `.git/config` name, `origin` first and the rest in file order. */
function remoteUrls(config: string): string[] {
  const remotes: { name: string; urls: string[] }[] = [];
  let current: { name: string; urls: string[] } | null = null;
  for (const line of config.split("\n")) {
    const section = /^\s*\[remote "([^"]+)"\]\s*$/.exec(line);
    if (section !== null) {
      current = { name: section[1], urls: [] };
      remotes.push(current);
    } else if (/^\s*\[/.test(line)) {
      current = null;
    } else {
      const url = /^\s*url\s*=\s*(\S.*?)\s*$/.exec(line);
      if (current !== null && url !== null) current.urls.push(url[1]);
    }
  }
  return [...remotes.filter(({ name }) => name === "origin"), ...remotes.filter(({ name }) => name !== "origin")].flatMap(({ urls }) => urls);
}

/** The picker's reads of the disk and the code host, and the `~` it writes paths with. */
type Surroundings = Readonly<{
  /** `path` with the home folder as `~`. */
  shown(path: string): string;
  /** `path` with a leading `~` made the home folder. */
  expanded(path: string): string;
  /** The repository the main checkout at `path` is of, or null when it is not one, or its remotes name none on this host. */
  repositoryOf(path: string): HostRepository | null;
  /** The main checkouts in the folder and one level below it. */
  checkouts(): Checkout[];
}>;

function surroundingsOf(deps: PickerDeps): Surroundings {
  const { cwd, home } = deps;
  const repositoryAt = new Map<string, HostRepository | null>();
  const read = (path: string): HostRepository | null => {
    if (!deps.isDirectory(join(path, ".git"))) return null;
    let config: string;
    try {
      config = deps.readFile(join(path, ".git", "config"));
    } catch (error) {
      void error; // a checkout whose config cannot be read names no repository
      return null;
    }
    return remoteUrls(config).map((url) => deps.repositories.repositoryOfRemote(url)).find((repository) => repository !== null) ?? null;
  };
  const repositoryOf = (path: string): HostRepository | null => {
    if (!repositoryAt.has(path)) repositoryAt.set(path, read(path));
    return repositoryAt.get(path) ?? null;
  };
  return {
    shown: (path) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path),
    expanded: (path) => (path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path),
    repositoryOf,
    checkouts() {
      const below = deps.listDir(cwd).filter((name) => !name.startsWith(".") && !SKIPPED_FOLDERS.has(name)).sort().map((name) => join(cwd, name));
      return [cwd, ...below].flatMap((path) => {
        const repository = repositoryOf(path);
        return repository === null ? [] : [{ repository, path }];
      });
    },
  };
}

/** The host file's clones with their paths made absolute. */
const heldOf = (clones: Held, surroundings: Surroundings): Held => Object.fromEntries(Object.entries(clones).map(([name, path]) => [name, resolve(surroundings.expanded(path))]));

/** The key the host file holds the checkout at `path` under, or undefined. */
const keyAt = (held: Held, path: string): string | undefined => Object.entries(held).find(([, heldPath]) => heldPath === path)?.[0];

/**
 * One checkout for each repository found: when several are of one repository, the host file's path wins (onboard's keep rule), then the folder that has the repository's name, then the first in path order.
 * @returns the checkouts by name, case-insensitively
 */
function onePerRepository(found: readonly Checkout[], held: Held): Checkout[] {
  const byRepository = new Map<string, Checkout[]>();
  for (const checkout of found) byRepository.set(checkout.repository.fullName.toLowerCase(), [...(byRepository.get(checkout.repository.fullName.toLowerCase()) ?? []), checkout]);
  const chosen = [...byRepository.values()].map((checkouts) => {
    const sorted = [...checkouts].sort((a, b) => a.path.localeCompare(b.path));
    return sorted.find(({ path }) => keyAt(held, path) !== undefined) ?? sorted.find(({ path, repository }) => basename(path) === repository.name) ?? sorted[0];
  });
  return chosen.sort((a, b) => a.repository.name.localeCompare(b.repository.name) || a.repository.fullName.localeCompare(b.repository.fullName));
}

/** The first two repositories in `picked` that share a name, as a sentence, or null. */
function sharedName(picked: readonly { name: string; fullName: string }[]): string | null {
  for (const [at, one] of picked.entries()) {
    const other = picked.slice(at + 1).find((candidate) => candidate.name === one.name && !same(candidate.fullName, one.fullName));
    if (other !== undefined) return `${one.fullName} and ${other.fullName} are both named ${one.name}, and the host file names a repository once: pick one`;
  }
  return null;
}

/** Asks `question` again, with the person's ticks kept, until `clashOf` finds nothing wrong with the answer. */
async function pickWithoutClash(question: Parameters<Prompts["pickMany"]>[0], clashOf: (picked: readonly string[]) => string | null, deps: PickerDeps): Promise<string[]> {
  let ticked = question.ticked;
  for (;;) {
    const picked = await deps.prompts.pickMany({ ...question, ticked });
    const clash = clashOf(picked);
    if (clash === null) return picked;
    deps.out.log(clash);
    ticked = picked;
  }
}

/** Where the host file holds the repository of `checkout` under its name when that is not the checkout's own path, else undefined: the host file's path is kept (onboard's keep rule). */
const heldElsewhere = ({ repository, path }: Checkout, held: Held): string | undefined => (keyAt(held, path) === undefined ? held[repository.name] : undefined);

/** The checkout rows of step 1: each ticked checkout, under the name the host file holds it by (its path's key, else the code host's name), at the path the host file holds it at. */
function foundRows(ticked: readonly Checkout[], held: Held): Row[] {
  return ticked.map((checkout): Row => {
    const { repository, path } = checkout;
    const elsewhere = heldElsewhere(checkout, held);
    if (elsewhere !== undefined) return { name: repository.name, path: elsewhere, fullName: repository.fullName, ok: true, how: KEPT, picked: true };
    return { name: keyAt(held, path) ?? repository.name, path, fullName: repository.fullName, ok: true, how: "found", picked: true };
  });
}

/** Step 1: what is checked out in the folder, pre-ticked. */
async function pickFound(found: readonly Checkout[], held: Held, context: Readonly<{ deps: PickerDeps; surroundings: Surroundings }>): Promise<Checkout[]> {
  const { deps, surroundings } = context;
  const hintOf = (checkout: Checkout): string => {
    const elsewhere = heldElsewhere(checkout, held);
    const where = elsewhere === undefined ? surroundings.shown(checkout.path) : `in the host file at ${surroundings.shown(elsewhere)}: kept there`;
    return `${checkout.repository.fullName}  ${where}`;
  };
  const choices: Choice<string>[] = found.map((checkout) => ({ value: checkout.repository.fullName, label: checkout.repository.name, hint: hintOf(checkout) }));
  const clashOf = (picked: readonly string[]) => sharedName(found.filter(({ repository }) => picked.includes(repository.fullName)).map(({ repository }) => repository));
  const picked = await pickWithoutClash({ message: `Found ${plural(found.length, "repository", "repositories")} in ${surroundings.shown(deps.cwd)}`, choices, ticked: choices.map(({ value }) => value), filter: false, required: false }, clashOf, deps);
  return found.filter(({ repository }) => picked.includes(repository.fullName));
}

/** The owner of `owner/name`. */
const ownerOf = (fullName: string): string => fullName.slice(0, fullName.indexOf("/"));

/** The held entries as repositories: by the checkout at their path, else by their key naming a repository the code host lists. */
function heldRepositories(held: Held, surroundings: Surroundings): { key: string; path: string; repository: HostRepository | null }[] {
  return Object.entries(held).map(([key, path]) => ({ key, path, repository: surroundings.repositoryOf(path) }));
}

/** Step 2, the owners: the account and its organisations, with the owners of what is already picked or held ticked. @returns the owners ticked, or null when the code host cannot list them */
async function pickOwners(interesting: readonly string[], deps: PickerDeps): Promise<RepositoryOwner[] | null> {
  const owners = deps.repositories.readOwners();
  if (owners === null) return null;
  const choices: Choice<string>[] = owners.map(({ login, kind }) => ({ value: login, label: kind === "account" ? `${login} (your account)` : login }));
  const ticked = owners.filter(({ login }) => interesting.some((owner) => same(owner, login))).map(({ login }) => login);
  const picked = await deps.prompts.pickMany({ message: "Organisations to add repositories from", choices, ticked, filter: false, required: true });
  return owners.filter(({ login }) => picked.includes(login));
}

/** The repositories of `owners`, each once, by `owner/name`. A list the code host cannot give is said and left out. @returns null when none could be given */
function repositoriesOf(owners: readonly RepositoryOwner[], deps: PickerDeps): HostRepository[] | null {
  const lists = owners.map((owner) => ({ owner, repositories: deps.repositories.readRepositories(owner) }));
  for (const { owner, repositories } of lists) if (repositories === null) deps.out.log(`could not list ${owner.login}'s repositories`);
  if (lists.every(({ repositories }) => repositories === null)) return null;
  const byName = new Map<string, HostRepository>();
  for (const repository of lists.flatMap(({ repositories }) => repositories ?? [])) byName.set(repository.fullName.toLowerCase(), repository);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.fullName.localeCompare(b.fullName));
}

/** The key the host file holds `repository` under: the entry whose checkout is of it, else the entry named as it is. */
function heldKeyOf(repository: HostRepository, heldRepos: ReturnType<typeof heldRepositories>): string | undefined {
  return heldRepos.find((entry) => entry.repository !== null && same(entry.repository.fullName, repository.fullName))?.key ?? heldRepos.find((entry) => entry.key === repository.name && entry.repository === null)?.key;
}

/** Step 2: the listed repositories the person ticks, other than those step 1 showed. @returns the repositories ticked, or null when the code host could not list them */
async function pickListed(context: Readonly<{ shown: readonly Checkout[]; picked: readonly Row[]; held: Held; deps: PickerDeps; surroundings: Surroundings }>): Promise<HostRepository[] | null> {
  const { shown, picked, held, deps, surroundings } = context;
  const heldRepos = heldRepositories(held, surroundings);
  const interesting = [...picked.flatMap(({ fullName }) => (fullName === null ? [] : [ownerOf(fullName)])), ...heldRepos.flatMap(({ repository }) => (repository === null ? [] : [ownerOf(repository.fullName)]))];
  const owners = await pickOwners(interesting, deps);
  const listed = owners === null ? null : repositoriesOf(owners, deps);
  if (listed === null) return null;
  const options = listed.filter((repository) => !shown.some((checkout) => same(checkout.repository.fullName, repository.fullName)));
  if (options.length === 0) {
    deps.out.log("There are no other repositories to add.");
    return [];
  }
  const hintOf = (repository: HostRepository): string => {
    const key = heldKeyOf(repository, heldRepos);
    return key === undefined ? "not cloned" : `in the host file ${surroundings.shown(held[key])}`;
  };
  const choices: Choice<string>[] = options.map((repository) => ({ value: repository.fullName, label: repository.fullName, hint: hintOf(repository) }));
  const ticked = options.filter((repository) => heldKeyOf(repository, heldRepos) !== undefined).map(({ fullName }) => fullName);
  const clashOf = (chosen: readonly string[]) => {
    const repositories = options.filter(({ fullName }) => chosen.includes(fullName));
    return sharedName([...picked.flatMap(({ fullName, name }) => (fullName === null ? [] : [{ name, fullName }])), ...repositories]) ?? heldClash(repositories, heldRepos);
  };
  const chosen = await pickWithoutClash({ message: "Repositories to add (type to filter)", choices, ticked, filter: true, required: false }, clashOf, deps);
  return options.filter(({ fullName }) => chosen.includes(fullName));
}

/** A sentence when a repository's name is already held for another repository, or null. */
function heldClash(repositories: readonly HostRepository[], heldRepos: ReturnType<typeof heldRepositories>): string | null {
  for (const repository of repositories) {
    const holder = heldRepos.find((entry) => entry.key === repository.name && entry.repository !== null && !same(entry.repository.fullName, repository.fullName));
    if (holder !== undefined) return `${repository.fullName} and ${holder.repository!.fullName} (in the host file) are both named ${repository.name}, and the host file names a repository once: pick one`;
  }
  return null;
}

/** The folder the clones go into: asked once, starting as the folder onboard runs in, asked again for a path that is not absolute. */
async function askCloneFolder(context: Readonly<{ deps: PickerDeps; surroundings: Surroundings }>): Promise<string> {
  const { deps, surroundings } = context;
  for (;;) {
    const answer = surroundings.expanded((await deps.prompts.text({ message: "Clone into", initial: surroundings.shown(deps.cwd) })).trim());
    if (isAbsolute(answer)) return resolve(answer);
    deps.out.log(`${answer} is not an absolute path: give one that starts with / or ~/`);
  }
}

/** Where to clone `repository`, and what is already there: a checkout of it is used as it is, anything else is not cloned over. */
function placeFor(repository: HostRepository, folder: string, context: Readonly<{ surroundings: Surroundings; deps: PickerDeps }>): { path: string; existing: Row | null } {
  const { surroundings, deps } = context;
  const path = join(folder, repository.name);
  // `git clone` takes a destination that is an empty directory.
  if (!deps.exists(path) || (deps.isDirectory(path) && deps.listDir(path).length === 0)) return { path, existing: null };
  const there = surroundings.repositoryOf(path);
  const found: Row | null = there !== null && same(there.fullName, repository.fullName) ? { name: repository.name, path, fullName: repository.fullName, ok: true, how: "found", picked: true } : null;
  return { path, existing: found ?? { name: repository.name, path, fullName: repository.fullName, ok: false, how: `not cloned: ${surroundings.shown(path)} exists and is not a checkout of ${repository.fullName}`, picked: true } };
}

/** The rows of the repositories step 2 ticked: one the host file holds is kept, one with a checkout is found, and the rest are offered for cloning, with the command shown. */
async function rowsOfListed(listed: readonly HostRepository[], context: Readonly<{ held: Held; deps: PickerDeps; surroundings: Surroundings }>): Promise<Row[]> {
  const { held, deps, surroundings } = context;
  const heldRepos = heldRepositories(held, surroundings);
  const rows: Row[] = [];
  const wanted: HostRepository[] = [];
  for (const repository of listed) {
    const key = heldKeyOf(repository, heldRepos);
    if (key === undefined) wanted.push(repository);
    else rows.push({ name: key, path: held[key], fullName: repository.fullName, ok: true, how: KEPT, picked: true });
  }
  if (wanted.length === 0) return rows;
  const folder = await askCloneFolder({ deps, surroundings });
  const places = wanted.map((repository) => ({ repository, ...placeFor(repository, folder, { surroundings, deps }) }));
  rows.push(...places.flatMap(({ existing }) => (existing === null ? [] : [existing])));
  return [...rows, ...await cloneOffered(places.filter(({ existing }) => existing === null), { deps, surroundings })];
}

/** Offers each clone as the command it runs, all ticked, and runs those left ticked, saying each. A clone that fails is a row with the host's reason; one declined is left out. */
async function cloneOffered(offered: readonly { repository: HostRepository; path: string }[], context: Readonly<{ deps: PickerDeps; surroundings: Surroundings }>): Promise<Row[]> {
  const { deps, surroundings } = context;
  if (offered.length === 0) return [];
  const choices: Choice<string>[] = offered.map(({ repository, path }) => ({ value: repository.fullName, label: deps.repositories.cloneCommand(repository.fullName, surroundings.shown(path)) }));
  const ticked = await deps.prompts.pickMany({ message: "Clone these repositories? Each runs the command shown", choices, ticked: choices.map(({ value }) => value), filter: false, required: false });
  const rows: Row[] = [];
  for (const { repository, path } of offered) {
    const row = { name: repository.name, path, fullName: repository.fullName, picked: true };
    if (!ticked.includes(repository.fullName)) {
      rows.push({ ...row, ok: false, how: "not cloned" });
      continue;
    }
    deps.out.log(`  Cloning ${repository.fullName} …`);
    const refusal = deps.repositories.cloneRepository(repository.fullName, path);
    rows.push(refusal === null ? { ...row, ok: true, how: "cloned" } : { ...row, ok: false, how: `not cloned: ${refusal}` });
  }
  return rows;
}

/** The host file's own entries that no row speaks for: onboard never removes one, so the summary says each is kept. */
function keptRows(rows: readonly Row[], held: Held, surroundings: Surroundings): Row[] {
  return heldRepositories(held, surroundings).filter(({ key }) => !rows.some(({ name }) => name === key))
    .map(({ key, path, repository }): Row => ({ name: key, path, fullName: repository?.fullName ?? null, ok: true, how: KEPT, picked: false }));
}

/** The summary: a header, one line for each repository (a mark, the name the host file holds, the path and how it came to be), and the outcome. */
function summaryOf(rows: readonly Row[], surroundings: Pick<Surroundings, "shown">): string {
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.max(0, ...sorted.map(({ name }) => name.length));
  const pathWidth = Math.max(0, ...sorted.map(({ path }) => surroundings.shown(path).length));
  const lines = sorted.map(({ ok, name, path, how }) => `  ${ok ? "✓" : "✗"} ${name.padEnd(nameWidth)}  ${surroundings.shown(path).padEnd(pathWidth)}  ${how}`);
  const going = sorted.filter(({ ok }) => ok).length;
  return ["Repositories", "", ...lines, "", `${going === 1 ? "1 repository goes" : `${going} repositories go`} into the host file.`].join("\n");
}

/** What is said when step 2 cannot list: what to run. With nothing found to go on with, it ends with {@link NAME_THEM_BY_PATH}. */
const UNREADABLE = "could not list your GitHub repositories (run `gh auth login` if you are not signed in)";
const NAME_THEM_BY_PATH = ", so name them by path";

/**
 * Picks the repositories a worker can choose from: the checkouts in the folder onboard runs in, then, if asked, more from the code host. `clones` is the host file's own, kept as it is.
 * Prints the summary before it returns. @returns the repositories picked, or null when none were found and the code host could not list any: the caller asks for paths instead
 * @throws PromptCancelled when the person stops a prompt
 */
export async function pickRepositories(clones: Held, deps: PickerDeps): Promise<PickedRepository[] | null> {
  const surroundings = surroundingsOf(deps);
  const held = heldOf(clones, surroundings);
  const found = onePerRepository(surroundings.checkouts(), held);
  let rows: Row[] = [];
  if (found.length > 0) rows = foundRows(await pickFound(found, held, { deps, surroundings }), held);
  else deps.out.log(`No repositories from GitHub in ${surroundings.shown(deps.cwd)}`);
  if (found.length === 0 || await deps.prompts.confirm({ message: "Add repositories not cloned here?", initial: false })) {
    const added = await addFromHost({ shown: found, picked: rows, held, deps, surroundings });
    if (added === null) return null;
    rows = [...rows, ...added];
  }
  // A blank line either side sets the summary apart from the prompts above it and the steps that follow.
  deps.out.log(`\n${summaryOf([...rows, ...keptRows(rows, held, surroundings)], surroundings)}\n`);
  return rows.filter(({ ok, picked, fullName }) => ok && picked && fullName !== null).map(({ name, path, fullName }) => ({ name, path, fullName: fullName! })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Step 2 as a whole: the rows it adds (none when the code host cannot list and step 1 found something to go on with), or null when it cannot list and nothing was found, so the caller asks for paths. */
async function addFromHost(context: Readonly<{ shown: readonly Checkout[]; picked: readonly Row[]; held: Held; deps: PickerDeps; surroundings: Surroundings }>): Promise<Row[] | null> {
  const { shown, held, deps, surroundings } = context;
  const listed = await pickListed(context);
  if (listed !== null) return rowsOfListed(listed, { held, deps, surroundings });
  if (shown.length > 0) {
    deps.out.log(UNREADABLE);
    return [];
  }
  deps.out.log(`${UNREADABLE}${NAME_THEM_BY_PATH}`);
  return null;
}
