import { act, renderHook } from "@testing-library/react";
import { draftsKey, useDrafts } from "../settings/use-drafts.ts";
import { cacheKey, clearCached, readCached, writeCached } from "./session-cache.ts";
import type { ViewConnection } from "./types.ts";

const HERE: ViewConnection = { name: "here", kind: "local" };
const PERSONAL: ViewConnection = { name: "personal", kind: "ssh" };

/** Replaces the tab's `sessionStorage` for one check, as a private window or a full store does, and puts it back after. */
function withStorage(storage: () => Storage) {
  const own = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: storage });
  return () => {
    if (own !== undefined) Object.defineProperty(globalThis, "sessionStorage", own);
  };
}

describe("the answers a tab keeps (A11-270)", () => {
  it("gives back the answer kept for a connection and a path, with when it was read", () => {
    const before = Date.now();
    writeCached(PERSONAL, "/api/queue", { entries: [1] });
    const kept = readCached(PERSONAL, "/api/queue");
    expect(kept?.data).toEqual({ entries: [1] });
    expect(kept?.readAt).toBeGreaterThanOrEqual(before);
    expect(kept?.readAt).toBeLessThanOrEqual(Date.now());
  });

  it("keeps one instance's answer from another's, and one path's from another's", () => {
    writeCached(PERSONAL, "/api/queue", { entries: [1] });
    expect(readCached(HERE, "/api/queue")).toBeNull();
    expect(readCached({ name: "personal", kind: "https" }, "/api/queue")).toBeNull();
    expect(readCached(PERSONAL, "/api/tickets")).toBeNull();
    expect(cacheKey(null, "/api/connections")).not.toBe(cacheKey(HERE, "/api/connections"));
  });

  it("gives nothing for a kept value it cannot read: not JSON, or not the shape it writes", () => {
    sessionStorage.setItem(cacheKey(HERE, "/api/config"), "{not json");
    sessionStorage.setItem(cacheKey(HERE, "/api/queue"), JSON.stringify({ data: [] }));
    expect(readCached(HERE, "/api/config")).toBeNull();
    expect(readCached(HERE, "/api/queue")).toBeNull();
  });

  it("works without storage where the browser refuses it: nothing is kept and nothing throws", () => {
    const restore = withStorage(() => {
      throw new Error("SecurityError: storage is disabled");
    });
    try {
      expect(() => writeCached(HERE, "/api/queue", { entries: [] })).not.toThrow();
      expect(readCached(HERE, "/api/queue")).toBeNull();
    } finally {
      restore();
    }
  });

  it("drops the older copy when a newer answer does not fit, so the next page never draws an answer older than the last one read", () => {
    writeCached(HERE, "/api/queue", { entries: ["old"] });
    const real = sessionStorage;
    const full = {
      getItem: (key: string) => real.getItem(key),
      removeItem: (key: string) => real.removeItem(key),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    const restore = withStorage(() => full);
    try {
      expect(() => writeCached(HERE, "/api/queue", { entries: ["new"] })).not.toThrow();
      expect(readCached(HERE, "/api/queue")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("what a person typed comes before the answers a tab kept (A11-270)", () => {
  it("clearCached drops the kept answers and nothing else the tab holds", () => {
    writeCached(HERE, "/api/queue", { entries: [] });
    sessionStorage.setItem(draftsKey("here"), JSON.stringify({ "tickets.drafts": "x" }));
    clearCached();
    expect(readCached(HERE, "/api/queue")).toBeNull();
    expect(sessionStorage.getItem(draftsKey("here"))).not.toBeNull();
  });

  it("a storage too full for the drafts drops the kept answers to make room, so the staged changes survive a move to another page", () => {
    writeCached(HERE, "/api/queue", { entries: ["large"] });
    const real = sessionStorage;
    const holdsAnswers = () => Array.from({ length: real.length }, (_, index) => real.key(index) ?? "").some((key) => key.startsWith("ticket-mode.read."));
    const full = {
      get length() { return real.length; },
      key: (index: number) => real.key(index),
      getItem: (key: string) => real.getItem(key),
      removeItem: (key: string) => real.removeItem(key),
      setItem: (key: string, value: string) => {
        if (holdsAnswers()) throw new Error("QuotaExceededError");
        real.setItem(key, value);
      },
    } as unknown as Storage;
    const restore = withStorage(() => full);
    try {
      const { result } = renderHook(() => useDrafts("here"));
      act(() => result.current.type("tickets.drafts", "typed"));
      expect(JSON.parse(real.getItem(draftsKey("here")) ?? "{}")).toEqual({ "tickets.drafts": "typed" });
      expect(holdsAnswers()).toBe(false);
    } finally {
      restore();
    }
  });
});
