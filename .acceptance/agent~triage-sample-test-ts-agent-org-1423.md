The triage-sample test file imports its `Figures` type as a type (`import { type Figures }`), so Node's type stripping no longer fails the whole file at link time. The typo case (`--cause answer-owd`) already pins its own `--from`/`--to` window (f1012b50, #1396), so it reads no wall clock; it passes with the system clock after 2026-10-15.

Acceptance:
```bash
node --test src/trace/triage-sample.test.ts
```

Consumer-declaration: none -- a test file's type import; no module the tool runs imports it.
