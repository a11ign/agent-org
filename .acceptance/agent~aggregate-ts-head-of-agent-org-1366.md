HEAD_OF_KEY in src/trace/aggregate.ts reads the head out of a settled-red key that ends `/conflicting` or `/refail-<n>`, so changeOf can tell that the head moved for such a key.

Acceptance:
```bash
node --import=./src/lib/crash-exit.ts --test src/trace/aggregate.test.ts
```

Mutation: the new SPLIT test fails before the change (`/conflicting` reads `[0, 2, 0]`, expected `[1, 1, 0]`). With the head group widened to `[\w]{7,40}` the same test fails on the suffixed key with no head, so the marker over-fires and is caught.
