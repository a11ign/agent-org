import type { OutcomeGroup } from "../api/types.ts";
import { dollarsFull, dollarsText, figureOf, outcomesQueryOf, weekAfter, weekBefore } from "./outcomes-model.ts";

const PRICED_AT = "at configured prices";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A group of no runs: every rate is of nothing. */
const nothing: OutcomeGroup = {
  key: "opus/high", runs: [], cost: { usd: 0, floor: false }, reviewerCost: { usd: 0, floor: false },
  roundsPerPr: { value: null, rounds: 0, prs: 0, runs: [] }, firstPass: { value: null, runs: [], of: [] }, needsYou: { value: null, runs: [], of: [] },
};

describe("the dollar figures", () => {
  it("are cents under $100 and whole dollars from there", () => {
    expect(dollarsText({ usd: 3.456, floor: false })).toBe("$3.46");
    expect(dollarsText({ usd: 1234.5, floor: false })).toBe("$1,235");
  });

  it("say a floor is at least that much, and why, in full", () => {
    expect(dollarsText({ usd: 2, floor: true })).toBe("≥ $2.00");
    expect(dollarsFull({ usd: 2, floor: true }, PRICED_AT)).toBe("At least $2.00 at configured prices: some tokens behind it could not be read or have no configured price");
    expect(dollarsFull({ usd: 2, floor: false }, PRICED_AT)).toBe("$2.00 at configured prices");
  });
});

describe("a figure with nothing behind it", () => {
  it.each(["roundsPerPr", "firstPass", "needsYou"] as const)("%s is a dash that links to no run", (column) => {
    const figure = figureOf(nothing, column, PRICED_AT);
    expect([figure.text, figure.runs]).toEqual(["—", []]);
  });
});

describe("a rate", () => {
  it("links to the runs it is out of, and says how many met it", () => {
    const group: OutcomeGroup = { ...nothing, runs: ["a", "b", "c"], firstPass: { value: 0.5, runs: ["a"], of: ["a", "b"] } };
    expect(figureOf(group, "firstPass", PRICED_AT)).toEqual({ text: "50%", full: "1 of 2 runs approved at the first review", runs: ["a", "b"] });
  });
});

describe("the window", () => {
  it("passes on only the page's from and to", () => {
    expect(outcomesQueryOf("?from=1&to=2&connection=work")).toBe("?from=1&to=2");
    expect(outcomesQueryOf("?connection=work&from=")).toBe("");
    expect(outcomesQueryOf("")).toBe("");
  });

  it("steps a week either way, and not past now", () => {
    const window = { from: 10 * WEEK_MS, to: 11 * WEEK_MS };
    expect(weekBefore(window)).toEqual({ from: 9 * WEEK_MS, to: 10 * WEEK_MS });
    expect(weekAfter(window, 12 * WEEK_MS)).toEqual({ from: 11 * WEEK_MS, to: 12 * WEEK_MS });
    expect(weekAfter(window, 11 * WEEK_MS)).toBeNull();
  });
});
