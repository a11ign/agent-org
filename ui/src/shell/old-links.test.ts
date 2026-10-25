import { oldLinkTarget } from "./old-links.ts";

describe("oldLinkTarget", () => {
  it.each([
    ["no query and no anchor", "", "", "/tickets"],
    ["a run's anchor", "", "#run-A11-1", "/runs/A11-1"],
    ["a run's anchor, and the instance its link names", "?connection=personal", "#run-A11-129", "/runs/A11-129?connection=personal"],
    ["a run key that needs encoding, as the old board's card id carried it", "?connection=work", "#run-A11%202", "/runs/A11%202?connection=work"],
    ["a writer request's anchor, which has no address of its own", "?connection=work", "#writer-w1", "/tickets?connection=work"],
    ["the Settings anchor", "", "#/settings", "/settings/models"],
    ["the Settings anchor, and the instance its link names", "?connection=personal", "#/settings", "/settings/models?connection=personal"],
    ["the instance alone", "?connection=personal", "", "/tickets?connection=personal"],
    ["any other query, kept whole", "?connection=a&x=1", "", "/tickets?connection=a&x=1"],
    ["an anchor the old board had no card for, kept for a place on Tickets", "?connection=personal", "#A11-9", "/tickets?connection=personal#A11-9"],
    ["an anchor that is not a valid encoding", "", "#run-%E0%A4%A", "/tickets#run-%E0%A4%A"],
    ["a bare run anchor with no key", "", "#run-", "/tickets#run-"],
  ])("sends %s", (_name, search, hash, target) => {
    expect(oldLinkTarget(search, hash)).toBe(target);
  });
});
