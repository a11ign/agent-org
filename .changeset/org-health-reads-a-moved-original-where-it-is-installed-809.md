---
"@a11ign/agent-org": patch
---

org-health's `copies-drifted` reads a copy whose original moved into an installed package (agent-org#809). The two tick copies `local-import-closure` and `worktree-resolution` are headed `COPIED FROM @a11ign/toolchain/lib/<stem>` and `COMPARED IN src/packaging/bootstrap-copies-match-toolchain.test.ts`; `readDeclaredCopies` reads the original through the installed package's own `exports` map, and the pair is compared (clear) only when that test is readable and still probes the stem. A package that is not installed, a module it no longer exports, a header naming no comparing test and a test that no longer probes the stem each read `unknown`, so the signal stops repeating `UNKNOWN` every tick without reading a missing original as clear.
