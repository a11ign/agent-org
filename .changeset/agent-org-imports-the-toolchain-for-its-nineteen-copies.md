---
"agent-org": minor
---

The tool no longer carries copies of the product's libraries: its 19 `// COPIED FROM` files in `src/lib` are deleted and every importer takes the same names from `@a11ign/toolchain/lib/<stem>` at the version `package.json` declares (`^0.7.0`; a11ign/a11ign#4425, phase 3, row 5 of 5). Four things move with that, and a project that installs the tool should read them before taking this release:

- `@a11ign/toolchain` is a `dependency`, not a `devDependency`: the gate, `pr:open` and the rest import it at run time, so an install that leaves it out stops at the first import. Anything that runs the tool from an installed checkout needs `@a11ign/toolchain@^0.7.0` in that install before it takes this version.
- `agent-org changed-files`, `changed-packages`, `ci-changed`, `isolation-gate` and `test-memory-cap` are removed from the command table, because each ran the main guard of a `src/lib` file that is no longer here. The same programs are `@a11ign/toolchain/lib/<name>`; `git grep` over a11ign at `98722a1fe` finds no script, workflow or `package.json` entry that names them.
- `src/lib/tree-wide-guard.ts` stays, as a one-line re-export of the toolchain's, because `agent-org/tree-wide-guard` is a declared export the product resolves (`packages/guards/src/tree-wide-guards.ts`); it goes when the product stops resolving it.
- The `copies-drifted` org-health signal, `readDeclaredCopies`, `copyDriftReading` and the `readCopies` hook of `orgHealthTick` are removed: there is no pair left to compare, so the `UNKNOWN -- 11 declared copy(ies) could not be compared` line that repeated every tick since 2026-10-10T16:14Z ends here.
