`ui/` moves to `@types/node` 26.6.5 (`ui/package.json`, `ui/pnpm-lock.yaml`; the root package stays at `^22.20.5`). The new types reject the cast in `worktreeOwner`'s default `read` dependency in `src/worktree-owner.ts` (`TS2352`), a server file `ui/tsconfig.json` reaches by import. The dependency is now typed as what it is, `(path: string) => string`, with no cast; the runtime read is unchanged.

Acceptance:
```bash
pnpm --dir ui install --frozen-lockfile --ignore-scripts
pnpm ui:typecheck
pnpm ui:build
pnpm ui:test
npm run typecheck
grep -q '"@types/node": "^26.6.5"' ui/package.json
grep -q '"@types/node": "^22.20.5"' package.json
```

Consumer-declaration: none -- no existing host file changes meaning. A devDependency of the private `ui/` package and the type of one injectable parameter move.
