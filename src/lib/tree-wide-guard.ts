// Not a copy: the one export that outlived the copies. `package.json` still exports `./tree-wide-guard` and the product resolves it
// (`agent-org/tree-wide-guard`) to recognise a guard that imports the marker from here, so the path stays and the code is the toolchain's.
export * from "@a11ign/toolchain/lib/tree-wide-guard";
