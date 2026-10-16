`outsideArmPass` hands its `lanes` to the real `arm-pr`, so authorship is judged from the lanes the caller passed (the a11ign `arm` job's checkout), not from the home checkout's file. A new test passes lanes that differ from the home file's and asserts the changed-file read (the proof authorship was judged) happens only under lanes that own the author; omitted, `arm-pr` falls back to the home file.

Acceptance:
```bash
node --test src/packaging/outside-arm.test.ts
```

Mutation: dropping `lanes` from the default `arm` in `outsideArmPass` (`src/auto-arm-sweep.ts`) fails the new test and no other (12 of 13 passed); restored byte-identical (`diff` against a copy).

Consumer-declaration: none -- test only; no module the tool runs imports it.
