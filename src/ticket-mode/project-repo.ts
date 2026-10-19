// @ts-check
// module: the repository a Linear project names, from the address in its summary -- one project, one repository, so a ticket in it is planned for that one

/** A GitHub address in a project's summary: `github.com/<owner>/<repo>`, with or without a scheme, and an optional `.git` or `/` after the repository. */
const ADDRESS = /(?:https?:\/\/)?github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?\/?(?=\s|$)/;

/**
 * The repository a project's summary names, as one of this machine's clones, or null. The name is the address's `<repo>`, never a folder: it is
 * returned only when it is one of `clones`, the host file's keys (A11-70). PURE.
 */
export function repoOfProject(summary: string | null | undefined, clones: readonly string[]): string | null {
  const repo = ADDRESS.exec(summary ?? "")?.[1];
  return repo !== undefined && clones.includes(repo) ? repo : null;
}
