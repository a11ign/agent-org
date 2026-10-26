// module: the import graph `check:changed` selects tests by (A11-307) -- who imports a file, directly or through other files, and which files name its path
//
// THE QUESTION IS "WHICH FILES REACH THIS ONE", ASKED OVER THE REVERSED GRAPH. A test covers a change when it imports the changed file, or imports a file that
// imports it, at any depth. A walk that stops at the first hop selects the tests of a leaf's direct importers only, and misses every test that reaches the leaf
// through a helper; `import-graph.test.ts` holds a three-hop chain to this.
//
// A DELETED OR MOVED FILE IS STILL REACHED. Its importers name a specifier that resolves to nothing now, so an importer with an unresolved specifier keeps an edge to every
// path the specifier could have meant, and a change that deleted `x.ts` finds the files that imported `x.ts`.
//
// A TEST THAT RUNS OR READS A FILE WITHOUT IMPORTING IT IS AN EDGE TOO: `new URL("./resolve-typescript.ts", import.meta.url)`, `spawn("node", [new URL("../wake.ts", import.meta.url)...])` and a
// `"../../plugins/github/wrapper/gh"` read all name a relative path in a string literal that resolves to a file, so a string literal that does is read as a reference to that file.
//
// WHAT THE GRAPH CANNOT SEE: an import built at run time (`import(\`./${name}.ts\`)`) and a path assembled from parts (`join("src", "x.ts")`). The first is not a relative string
// literal; the second is not the path. A test that scans the whole tree is not found by the file it scans: `select-tests.ts` runs those on any source change. CI runs every suite, so a test
// the graph misses is caught there; `check:changed` is the fast check, not the gate.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
// The tool's own comment stripper (blanks to whitespace of the same length), so a path or an import inside a comment is not an edge.
import { stripComments } from "../../src/lib/local-import-closure.ts";

/** Every file mapped to the files that import it directly, all paths relative to the repository root with `/` separators. */
export type ImporterMap = ReadonlyMap<string, readonly string[]>;

/** The files a graph is built from: their repo-relative path and their text with comments blanked. */
export interface SourceText { path: string; text: string }

/** How a file reaches a changed one: the changed file it started from, and the files between (importer first, the changed file last). */
export interface Reach { changed: string; via: readonly string[]; kind: "imports" | "names" }

const SPECIFIER = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
/** A string literal that is a relative path (`./x`, `../x/y.ts`), with no space or interpolation in it. */
const RELATIVE_PATH_LITERAL = /['"`](\.{1,2}\/[^'"`\s${}]+)['"`]/g;
const EXTENSION_TRIES = ["", ".ts", ".tsx", ".mjs", ".js"] as const;

const toRepoPath = (root: string, absolute: string): string => relative(root, absolute).split(sep).join(posix.sep);

/** The paths a relative specifier could mean, in the order Node and the tool's own closure walk try them. */
function candidatePaths(fromFile: string, specifier: string): string[] {
  const raw = resolve(dirname(fromFile), specifier);
  return [...EXTENSION_TRIES.map((extension) => `${raw}${extension}`), join(raw, "index.ts")];
}

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** What one relative specifier points at: the first path that exists, or every path it could have meant when none does (the file was deleted or moved). */
function resolveSpecifier(fromFile: string, specifier: string): string[] {
  const candidates = candidatePaths(fromFile, specifier);
  const found = candidates.find(isFile);
  return found === undefined ? candidates : [found];
}

/** The repo-relative files `file` imports by a relative specifier, or names in a relative path string literal that resolves to a file. */
export function readImportsOf(root: string, file: SourceText): string[] {
  const absolute = join(root, file.path);
  const imported = [...file.text.matchAll(SPECIFIER)].flatMap((match) => resolveSpecifier(absolute, match[1]));
  const named = [...file.text.matchAll(RELATIVE_PATH_LITERAL)].map((match) => resolve(dirname(absolute), match[1])).filter(isFile);
  return [...new Set([...imported, ...named].map((target) => toRepoPath(root, target)))];
}

/** Read every file in `paths` (repo-relative) with its comments blanked; a path that cannot be read is skipped. */
export function loadSources(root: string, paths: readonly string[]): SourceText[] {
  return paths.flatMap((path) => {
    try {
      return [{ path, text: stripComments(readFileSync(join(root, path), "utf8")) }];
    } catch {
      return [];
    }
  });
}

/** The reversed graph: for each file, the files that import it directly. */
export function buildImporterMap(root: string, sources: readonly SourceText[]): ImporterMap {
  const importers = new Map<string, string[]>();
  for (const source of sources) {
    for (const target of readImportsOf(root, source)) {
      const known = importers.get(target);
      if (known === undefined) importers.set(target, [source.path]);
      else known.push(source.path);
    }
  }
  return importers;
}

/** The sources whose text names `path` as a string, other than `path` itself: a test that reads a file by its path covers a change to it. */
export function sourcesNaming(sources: readonly SourceText[], path: string): string[] {
  return sources.filter((source) => source.path !== path && source.text.includes(path)).map((source) => source.path);
}

/** Walk the importers breadth-first from `seed`, recording for each file reached the chain that reached it. */
function walkImporters(importers: ImporterMap, seed: string, firstHop: readonly string[], reached: Map<string, Reach>, kind: Reach["kind"]): void {
  let frontier: Array<{ file: string; via: readonly string[] }> = firstHop.map((file) => ({ file, via: [seed] }));
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { file, via } of frontier) {
      if (reached.has(file)) continue;
      reached.set(file, { changed: seed, via, kind });
      for (const importer of importers.get(file) ?? []) next.push({ file: importer, via: [file, ...via] });
    }
    frontier = next;
  }
}

/**
 * Every file that reaches one of `changed`: by importing it, at any depth, or by naming its path (and then every file that imports that one).
 * A changed file is not in the result unless another changed file reaches it.
 */
export function filesReaching(importers: ImporterMap, sources: readonly SourceText[], changed: readonly string[], options: { followNamers?: (changed: string) => boolean } = {}): Map<string, Reach> {
  const reached = new Map<string, Reach>();
  for (const seed of changed) walkImporters(importers, seed, importers.get(seed) ?? [], reached, "imports");
  for (const seed of changed) {
    const naming = sourcesNaming(sources, seed).filter((path) => !reached.has(path));
    // A file that names a path in prose (a prompt that says `AGENTS.md`) is reached, and the files that import IT are reached only when the name is a path something reads.
    if (options.followNamers?.(seed) ?? true) for (const path of naming) walkImporters(importers, seed, [path], reached, "names");
    else for (const path of naming) reached.set(path, { changed: seed, via: [seed], kind: "names" });
  }
  return reached;
}
