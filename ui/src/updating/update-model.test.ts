import { IDLE, isSlow, NO_UPDATE, SLOW_AFTER_MS, trackAfter, underwayOf, viewOf, type Read, type Track, type UpdateInfo } from "./update-model.ts";

const NOTE = { target: "v0.280.0", deadline: 0, finishing: 2, forced: false, stopped: 0 };
/** A normal update building v0.280.0 on an instance running v0.273.0. */
const NORMAL: UpdateInfo = { version: "v0.273.0", note: null, next: "v0.280.0" };
/** A breaking release draining: the drain note, and no `next` (the build is done and nothing is being built). */
const BREAKING: UpdateInfo = { version: "v0.273.0", note: NOTE, next: null };
const CALM: UpdateInfo = { version: "v0.273.0", note: null, next: null };

const failed = (update: UpdateInfo | null, at: number): Read => ({ state: "reconnecting", update, at });
const good = (update: UpdateInfo | null, at = 0): Read => ({ state: "ready", update, at });

describe("underwayOf: the reason the page has to think an update is in progress", () => {
  it("is a normal update when the instance says what it is moving to", () => {
    expect(underwayOf(NORMAL)).toEqual({ release: "normal", from: "v0.273.0", to: "v0.280.0" });
  });

  it("is a breaking release when a drain note stands, moving to the note's target", () => {
    expect(underwayOf(BREAKING)).toEqual({ release: "breaking", from: "v0.273.0", to: "v0.280.0" });
  });

  it("is a breaking release when the note stands whatever `next` says", () => {
    expect(underwayOf({ ...BREAKING, next: "v0.281.0" })).toEqual({ release: "breaking", from: "v0.273.0", to: "v0.280.0" });
  });

  it("is nothing for a calm instance, an instance that does not say, and a version it does not know", () => {
    expect(underwayOf(CALM)).toBeNull();
    expect(underwayOf(null)).toBeNull();
    expect(underwayOf(undefined)).toBeNull();
    expect(underwayOf({ version: "v0.273.0" })).toBeNull();
    expect(underwayOf({ ...NORMAL, version: null })).toBeNull();
  });

  it("is nothing when the update moves to the version the instance already runs", () => {
    expect(underwayOf({ ...BREAKING, version: "v0.280.0" })).toBeNull();
    expect(underwayOf({ ...NORMAL, next: "v0.273.0" })).toBeNull();
  });
});

describe("trackAfter: an outage is a run of reconnecting polls", () => {
  it("starts at the first failed poll, remembering what the last good read said", () => {
    expect(trackAfter(IDLE, failed(NORMAL, 1_000))).toEqual({ outage: { since: 1_000, known: NORMAL }, back: null });
  });

  it("keeps the outage's first failure and what was known then through the polls that fail after it", () => {
    const first = trackAfter(IDLE, failed(NORMAL, 1_000));
    expect(trackAfter(first, failed(NORMAL, 6_000))).toBe(first);
  });

  it("is Back when the first good read after the outage is on another version, as the version it read", () => {
    const out = trackAfter(IDLE, failed(NORMAL, 1_000));
    expect(trackAfter(out, good({ version: "v0.280.0", note: null, next: null }))).toEqual({ outage: null, back: { to: "v0.280.0", release: "normal" } });
  });

  it("names the version actually read, not the one that was expected", () => {
    const out = trackAfter(IDLE, failed(NORMAL, 1_000));
    expect(trackAfter(out, good({ version: "v0.281.0", note: null, next: null })).back).toEqual({ to: "v0.281.0", release: "normal" });
  });

  it("is a breaking Back when the outage began with a drain note", () => {
    const out = trackAfter(IDLE, failed(BREAKING, 1_000));
    expect(trackAfter(out, good({ version: "v0.280.0", note: null, next: null })).back).toEqual({ to: "v0.280.0", release: "breaking" });
  });

  it("is no Back when the instance came back on the same version: a plain restart, or an update that did not apply", () => {
    const out = trackAfter(IDLE, failed(NORMAL, 1_000));
    expect(trackAfter(out, good(CALM))).toEqual(IDLE);
  });

  it("is no Back when a version is not known on either side", () => {
    expect(trackAfter(trackAfter(IDLE, failed(null, 1_000)), good(CALM))).toEqual(IDLE);
    expect(trackAfter(trackAfter(IDLE, failed(NORMAL, 1_000)), good(null))).toEqual(IDLE);
  });

  it("is a Back after an outage that began with no reason to think of an update, when the version changed", () => {
    const out = trackAfter(IDLE, failed(CALM, 1_000));
    expect(trackAfter(out, good({ version: "v0.280.0", note: null, next: null })).back).toEqual({ to: "v0.280.0", release: "normal" });
  });

  it("changes nothing on a good read with no outage, a version change included", () => {
    expect(trackAfter(IDLE, good(CALM))).toBe(IDLE);
    expect(trackAfter(IDLE, good({ version: "v0.280.0", note: null, next: null }))).toBe(IDLE);
  });

  it("ends the outage with no screen on a state that is not a restart: an answered error, an unreachable SSH connection, loading", () => {
    const out = trackAfter(IDLE, failed(NORMAL, 1_000));
    for (const state of ["error", "unreachable", "loading"] as const) expect(trackAfter(out, { state, update: NORMAL, at: 2_000 })).toEqual(IDLE);
  });

  it("starts the outage again, and the Slow clock with it, after one that ended", () => {
    const ended = trackAfter(trackAfter(IDLE, failed(NORMAL, 1_000)), { state: "error", update: NORMAL, at: 2_000 });
    expect(trackAfter(ended, failed(NORMAL, 9_000)).outage).toEqual({ since: 9_000, known: NORMAL });
  });

  it("keeps Back through good reads, and drops it when a new outage begins", () => {
    const back = trackAfter(trackAfter(IDLE, failed(NORMAL, 1_000)), good({ version: "v0.280.0", note: null, next: null }));
    expect(trackAfter(back, good({ version: "v0.280.0", note: null, next: null }))).toBe(back);
    expect(trackAfter(back, failed(CALM, 9_000)).back).toBeNull();
  });
});

describe("viewOf: what the page shows", () => {
  const outage = (known: UpdateInfo | null): Track => trackAfter(IDLE, failed(known, 10_000));

  it("shows nothing when there is no outage, and none when the outage has no reason", () => {
    expect(viewOf(IDLE, 0)).toBe(NO_UPDATE);
    expect(viewOf(outage(CALM), 20_000)).toBe(NO_UPDATE);
    expect(viewOf(outage(null), 20_000)).toBe(NO_UPDATE);
  });

  it("shows Updating for a normal update and for a breaking one, with the versions", () => {
    expect(viewOf(outage(NORMAL), 11_000)).toEqual({ kind: "updating", release: "normal", from: "v0.273.0", to: "v0.280.0", slow: false });
    expect(viewOf(outage(BREAKING), 11_000)).toEqual({ kind: "updating", release: "breaking", from: "v0.273.0", to: "v0.280.0", slow: false });
  });

  it("shows Back once it is reached, over any outage", () => {
    const back = { outage: null, back: { to: "v0.280.0", release: "normal" as const } };
    expect(viewOf(back, 0)).toEqual({ kind: "back", to: "v0.280.0", release: "normal" });
  });
});

describe("the Slow threshold", () => {
  const outage = { since: 10_000, known: NORMAL };

  it("is 60 s of failed polls", () => {
    expect(SLOW_AFTER_MS).toBe(60_000);
  });

  it("is not Slow at 59.999 s and is Slow at 60 s", () => {
    expect(isSlow(outage, 10_000 + 59_999)).toBe(false);
    expect(isSlow(outage, 10_000 + 60_000)).toBe(true);
  });

  it("turns the Updating view Slow, and keeps the versions", () => {
    const track: Track = { outage, back: null };
    expect(viewOf(track, 10_000 + 59_999)).toMatchObject({ kind: "updating", slow: false });
    expect(viewOf(track, 10_000 + 60_000)).toEqual({ kind: "updating", release: "normal", from: "v0.273.0", to: "v0.280.0", slow: true });
  });
});
