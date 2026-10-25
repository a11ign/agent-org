import { fireEvent } from "@testing-library/react";
import { detailAddress, detailOf, MESSAGE, PUBLISHER_REASON, REFUSAL, RUN_KEY, type Machine } from "../../test/publish/publish-stand.ts";
import { headerButtons, pageFor, posts, screen, textOf, callout, waitFor, within } from "./run-detail-harness.tsx";

type Board = Parameters<typeof detailOf>[0];

/** Run detail for the Ready run as `board` draws it, on a machine with a publisher unless `machine` says none. */
const open = (board: Board, machine: Machine = {}) => pageFor("ready", detailOf(board, machine), detailAddress);

const PUBLISH_NOTE = "A person merges. Publish posts this pull request.";
const NO_PUBLISHER_NOTE = "A person merges. Nothing is published from here.";

describe("Publish on a machine with no publisher", () => {
  it.each<Board>(["ready", "publishing", "published", "failed"])("draws no Publish button on the %s board, and no disabled one", async (board) => {
    await open(board, { publisher: false });
    expect(headerButtons()).not.toContain("Publish");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });

  it("keeps the Ready board's sentence: a person merges and nothing is published from here", async () => {
    await open("ready", { publisher: false });
    expect(callout().getByText(NO_PUBLISHER_NOTE)).toBeTruthy();
    expect(screen.queryByText(PUBLISH_NOTE)).toBeNull();
  });

  it("shows no publish run's failure, since this machine has none", async () => {
    await open("failed", { publisher: false });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Publish on a machine with a publisher", () => {
  it("draws Publish first in the header of a Ready to merge run, with the board's sentence", async () => {
    await open("ready");
    expect(headerButtons()[0]).toBe("Publish");
    expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(false);
    expect(callout().getByText(PUBLISH_NOTE)).toBeTruthy();
    expect(screen.queryByText(NO_PUBLISHER_NOTE)).toBeNull();
  });

  it("posts that run's key alone to /api/publish, and has the shell read the queue again", async () => {
    const post = rstest.fn(() => ({ entries: [] }));
    const { fetchWith } = await open("ready", { post });
    const reads = () => fetchWith.requests.filter(({ method, path }) => method === "GET" && path.endsWith("/api/queue")).length;
    const before = reads();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(posts(fetchWith, "/api/publish")).toHaveLength(1));
    expect(posts(fetchWith, "/api/publish")[0].body).toEqual({ keys: [RUN_KEY] });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the Publishing board", () => {
  it("is the amber ring, the status word and a callout titled Publishing", async () => {
    await open("publishing");
    expect(screen.getByRole("img", { name: "Publishing" })).toBeTruthy();
    expect(textOf(document.querySelector(".run-head-status"))).toBe("Publishing");
    expect(callout().getByText("Publishing")).toBeTruthy();
    expect(callout().getByText("A publish run is posting a11ign/lab #150. Nothing is merged: a person still merges.")).toBeTruthy();
    expect(callout().getByText("A person merges. Publishing does not merge anything.")).toBeTruthy();
  });

  it("draws Publish disabled with the board's title, and no Dismiss, since the run's actions offer none while it is posted", async () => {
    await open("publishing");
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish.hasAttribute("disabled")).toBe(true);
    expect(publish.getAttribute("title")).toBe("A publish run is already posting this pull request");
    expect(headerButtons()).not.toContain("Dismiss");
  });

  it("links the publish run's own session, before the pull request's button", async () => {
    await open("publishing");
    const terminal = callout().getByRole("link", { name: "Open terminal" });
    expect(terminal.getAttribute("href")).toContain("ws-publish");
    expect(terminal.getAttribute("href")).toContain("p-publish");
    expect(terminal.getAttribute("title")).toBe("Opens the publish run's session in herdr");
    const links = callout().getAllByRole("link").map(textOf);
    expect(links.indexOf("Open terminal")).toBeLessThan(links.indexOf("Open #150 on GitHub"));
  });
});

describe("the Published board", () => {
  it("says what was posted and when, in the backend's own time, and offers no Publish", async () => {
    await open("published");
    expect(textOf(document.querySelector(".run-head-status"))).toBe("Published");
    expect(screen.getByRole("img", { name: "Published" })).toBeTruthy();
    expect(callout().getByText("Posted a11ign/lab #150 at 09:12. Nothing was merged: a person still merges.")).toBeTruthy();
    expect(callout().getByText("A person merges. Nothing was merged by publishing.")).toBeTruthy();
    expect(headerButtons()).not.toContain("Publish");
  });

  it("links the posted message beside the pull request's button", async () => {
    await open("published");
    expect(callout().getByRole("link", { name: "Slack message" }).getAttribute("href")).toBe(MESSAGE);
    expect(callout().getByRole("link", { name: "Slack message" }).getAttribute("title")).toBe("Open the Slack message");
  });
});

describe("a publish that did not happen", () => {
  it("shows the server's own sentence under Not published., and leaves Publish to press again", async () => {
    await open("ready", { post: () => ({ status: 409, error: REFUSAL }) });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Not published.")).toBeTruthy();
    expect(within(alert).getByText(REFUSAL)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows the publisher's reason for a publish run that failed with this run among its keys, and Publish is available again", async () => {
    await open("failed");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Not published.")).toBeTruthy();
    expect(within(alert).getByText(`Publishing 1 run failed: ${PUBLISHER_REASON}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(false);
  });

  it("hides the sentence when Dismiss is pressed", async () => {
    await open("failed");
    fireEvent.click(await within(await screen.findByRole("alert")).findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not carry the failure of a publish run that did not have this run among its keys", async () => {
    const stand = detailOf("failed");
    const instance = stand.instances?.personal;
    if (instance?.queue?.publish === undefined) throw new Error("the stand holds no publish run");
    await pageFor("ready", { ...stand, instances: { personal: { ...instance, queue: { ...instance.queue, publish: { ...instance.queue.publish, keys: ["A11-1"] } } } } }, detailAddress);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts a press's own refusal ahead of the publish sentence, under no heading", async () => {
    await open("failed", { post: () => ({ status: 409, error: "A11-180 is already gone" }) });
    fireEvent.click(screen.getByRole("button", { name: "Respond to review" }));
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("A11-180 is already gone");
    expect(within(alert).queryByText("Not published.")).toBeNull();
  });
});
