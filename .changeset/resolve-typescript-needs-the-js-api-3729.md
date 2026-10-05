---
"agent-org": patch
---

`resolveTypescript` accepts a `typescript` only if it exposes the JS compiler API the tool calls (`createSourceFile` and `ScriptTarget`), and otherwise tries the next place (a11ign/a11ign#3729). TypeScript 7 is the native compiler: its `typescript` entry point loads without throwing and has no `ScriptTarget`, so a project pinning `typescript` 7.x had its copy returned first and `pr:open` crashed at `ts.ScriptTarget.Latest`, the fallback to the tool's own tree never taken. When no place has the API the error now names each candidate rejected and why. A project with a working `typescript` 5 or 6 still resolves to its own, first. `lib/tree-wide-guard.mjs` is a declared copy and is not changed here.
