The file `src/packaging/region-paths-checkout.test.ts` makes its git sandboxes in a directory of its own (`before` points `TMPDIR` at it, `after` removes it and puts the run's `TMPDIR` back), so a sandbox a test leaves behind is removed by the file's own cleanup and the run's private-TMPDIR teardown has nothing of this file's to name. The CONTROL case fails when the sandboxes are made anywhere else. Nothing outside the file's own directory is touched, and the private-TMPDIR allowance is not widened.

Acceptance:
```bash
node --test src/packaging/region-paths-checkout.test.ts
```

Consumer-declaration: none -- a test file; no module the tool runs imports it.
