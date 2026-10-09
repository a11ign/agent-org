// #3443: WHAT A RELEASE TAG IS, AND WHICH ONE THE HOST RUNS -- pure, so `host-config.mjs` (a leaf) can validate `toolVersion` with the same pattern
// `update-tool.mjs` selects by, and neither states it twice.
//
// A release is `v<major>.<minor>.<patch>` and nothing else: `release.yml` cuts exactly that. A pre-release (`v0.8.0-rc1`), a moving name (`latest`) and
// a bare `0.7.8` are NOT releases, so they are never selected and never accepted as a pin. Order is NUMERIC, field by field (`v0.7.10` is newer than
// `v0.7.9`, which a lexical sort gets backwards).

/** `toolVersion`'s default: follow the newest release tag. */
export const LATEST = "latest";

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const isReleaseTag = (name: string): boolean => RELEASE_TAG.test(name);

/** Whether a `host.json` `toolVersion` is one the tool knows: `"latest"` or one release tag. */
export const isToolVersion = (value: unknown): boolean => value === LATEST || (typeof value === "string" && isReleaseTag(value));

const fields = (tag: string): number[] => (RELEASE_TAG.exec(tag) as RegExpExecArray).slice(1).map(Number);

/** Order two release tags numerically. */
export function compareReleaseTags(a: string, b: string): number {
  const [left, right] = [fields(a), fields(b)];
  return left.map((part, index) => part - right[index]).find((difference) => difference !== 0) ?? 0;
}

/**
 * The tag a `toolVersion` selects among the tags a checkout holds, or `null` when there is none: the newest release tag for `"latest"`, and for a pin exactly
 * that tag. `null` is "refuse", never "fall back": an absent pin is not the newest tag, and no tag is not `origin/main`.
 * @param tags every tag name, of any shape
 */
export function chooseReleaseTag(tags: string[], toolVersion: string): string | null {
  const releases = tags.filter(isReleaseTag);
  if (toolVersion !== LATEST) return releases.includes(toolVersion) ? toolVersion : null;
  return releases.toSorted(compareReleaseTags).at(-1) ?? null;
}
