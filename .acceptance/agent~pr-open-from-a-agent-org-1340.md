A `corpus` hit found by the acceptance scan's no-parser fallback names the fallback and the resolver's reason, on the refusal line `pr:open` prints (`closureRequirementMessage`). `resolve-typescript.ts` gains `tryResolveTypescript`, which returns the reason beside `null` where `resolveTypescript` throws, and `deriveClosureRequirements` marks a `corpus` hit with it as `noParser`. A hit found with a parser, and a `token` hit found without one, carry no note.

Acceptance:
```bash
bash -c 'cd ~/repos/agent-org && node --test src/lib/resolve-typescript.test.ts'
node --test --test-name-pattern="#1340" src/packaging/acceptance-commands.test.ts
```

Mutation: `noParser` never set fails the no-parser test in `acceptance-commands.test.ts` and not its control; `noParser` always set fails the control and not the no-parser test (measured).

Consumer-declaration: none -- nothing a consumer sets changes.
