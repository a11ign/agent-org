// Not a copy: the one export that outlived the copies. `package.json` still exports `./tree-wide-guard` and the product resolves it
// (`agent-org/tree-wide-guard`) to recognise a guard that imports the marker from here, so the path stays and the code is the toolchain's.
// The names are listed, not `export *`: `public-interface.test.ts` reads this file's exports without resolving imports, and a star re-export
// reads as none.
export { _lsFilesSpawnCountForTests, _typescriptLoadedForTests, declareTreeWideGuard, walkTree } from "@a11ign/toolchain/lib/tree-wide-guard";
export type { WalkedFile } from "@a11ign/toolchain/lib/tree-wide-guard";
