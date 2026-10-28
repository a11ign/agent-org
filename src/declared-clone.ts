// no-token: none -- pure; it imports nothing, so `doctor` and every reader of `clones` can use it without resolving a project (A11-292)
/**
 * A11-292: WHERE THE CLONE OF A DECLARED CODE REPOSITORY LIVES, FROM `clones`. A clone is listed under the repository's NAME (`.github`, `a11ign.github.io`: what `git clone` makes, and what
 * a reviewer of a repository the project does not declare is found by) or under its declared KEY (`github`), and the two differ for any repository whose name holds a character the key cannot
 * (a key is `[a-z0-9-]`, ADR 0040), so `clones[".github"]` was never found by the key `github` and no pull request there was ever reviewed. The KEY is asked first, as it always was, then the repository's
 * NAME. The name is no answer when ANY OTHER declared repository has it for its key or its own name (the primary's `a11ign` included): that clone is that repository's checkout, not this one's, as
 * `clonedSeatOf` refuses the same clash. The primary (`""`) has no declared clone: its checkout is the tick's own.
 *
 * It lives apart from `host-config.ts` because that module resolves the project at import and a doctor must still run, and say so, on a machine where none resolves.
 */

/** A code repository the project declares: its key, and its `owner/name`. */
export type DeclaredRepository = Readonly<{ key: string; repo: string }>;

const nameOf = (repo: string): string | undefined => repo.split("/").pop();

/**
 * @param clones `host.json`'s `clones`, by key or by repository name
 * @param key the declared key to find the clone of
 * @param code the project's declared code repositories
 * @returns the clone, or the names it was looked up under
 */
export function cloneOfDeclared(clones: Readonly<Record<string, string>> | undefined, key: string, code: readonly DeclaredRepository[]): { clone: string; } | { tried: string[]; } {
  const name = key === "" ? undefined : nameOf(code.find((declared) => declared.key === key)?.repo ?? "");
  const shared = name === undefined || name === "" || name === key || code.some((other) => other.key !== key && (other.key === name || nameOf(other.repo) === name));
  const tried = shared ? [key] : [key, name];
  const found = tried.find((candidate) => clones !== undefined && Object.hasOwn(clones, candidate));
  return found === undefined ? { tried } : { clone: clones![found] };
}

/** `owner/name` of the GitHub repository a git remote URL (`https://github.com/o/n.git`, `git@github.com:o/n`) names, or undefined for another host's. */
export function repositoryOfRemoteUrl(url: string): string | undefined {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?\s*$/i.exec(url.trim())?.[1];
}

/**
 * A11-360: THE REPOSITORY (`owner/name`) A CLONE IN `clones` IS THE CHECKOUT OF. A key is a repository's NAME, or an alias for it (`github` for `.github`): the declared repository whose key (or name) it is wins, then the
 * repository the clone's own git remote names (`remote` reads it from the clone's path). Undefined when neither says: the caller may take the key for a name then (a clone whose remote cannot be read), but never before
 * either was asked, since a name made from the alias is how `a11ign/github`, which is no repository, was swept.
 */
export function repositoryOfClone(key: string, path: string, { code, remote }: Readonly<{ code: readonly DeclaredRepository[]; remote: (path: string) => string | undefined }>): string | undefined {
  const declared = code.find((repository) => repository.key === key) ?? code.find((repository) => nameOf(repository.repo) === key);
  if (declared !== undefined) return declared.repo;
  const url = remote(path);
  return url === undefined ? undefined : repositoryOfRemoteUrl(url);
}
