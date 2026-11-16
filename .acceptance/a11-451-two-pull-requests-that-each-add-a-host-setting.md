The defaults assertion in `src/ticket-mode/settings.test.ts` and the full-settings fixture in `src/ticket-mode/config-schema.test.ts` put each key on a line of its own, with the assertions unchanged. Two pull requests that each add a different `tickets.*` key now merge without a conflict in either file when the keys sit in different places, including next to each other. Two keys added in the very same gap, between the same two lines, still conflict: that is how git merges, and no layout avoids it.

Acceptance:
```bash
# 1. both files pass (59 tests, as on the base)
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/settings.test.ts src/ticket-mode/config-schema.test.ts

# 2. the defaults assertion is one key per line: no line of it is longer than 120 characters
test "$(sed -n '/override the defaults/,/^});/p' src/ticket-mode/settings.test.ts | awk 'length > 120' | wc -l)" -eq 0

# 3. two scratch branches each add a different key next to the other's, in both files; merging them gives no conflict on this head and does on the base
merge_demo() { # $1 = revision to branch from
  T=$(mktemp -d) && git clone -q . "${T:?}/r" && cd "${T:?}/r" && git checkout -q -b a "$1" && git checkout -q -b b "$1" || return 2
  for n in a b; do
    git checkout -q $n
    anchor=$([ $n = a ] && echo evalTokenCap || echo updateMaxDeferHours)
    for f in src/ticket-mode/settings.test.ts src/ticket-mode/config-schema.test.ts; do
      if grep -qE "^ +$anchor: [^,]*,$" $f; then sed -i -E "s/^( +)($anchor: [^,]*,)$/\1\2\n\1newKey_$n: 1,/" $f
      else sed -i -E "s/($anchor: [^,]*,)/\1 newKey_$n: 1,/" $f; fi
    done
    git commit -qam "add $n"
  done
  git merge -q --no-edit a >/dev/null 2>&1; r=$?; cd - >/dev/null; rm -rf "${T:?}/r"; return $r
}
merge_demo HEAD && echo "this head: merge clean"
merge_demo HEAD~1 && { echo "base merged clean: the demo cannot fail"; exit 1; } || echo "base: merge conflict, as expected"
```
