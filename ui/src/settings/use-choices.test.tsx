import { act, renderHook } from "@testing-library/react";
import type { Client } from "../api/client.ts";
import type { ConfigView } from "../api/types.ts";
import { modelsConfig } from "../../test/settings/settings-stand.ts";
import { useChoices } from "./use-choices.ts";

// A11-294: a read of /api/config that lands while a save is in flight replaces the config object; the answer to the save must still show what was saved, not the older read's choice.
describe("a choice saved while the page reads its config again", () => {
  it("still shows the saved value when the config is replaced before the save answers", async () => {
    const first = modelsConfig();
    const answer: { resolve: (value: unknown) => void } = { resolve: () => undefined };
    const saveChoice = () => new Promise((resolve) => { answer.resolve = resolve; });
    const client = { saveChoice } as unknown as Client;
    const { result, rerender } = renderHook(({ config }: { config: ConfigView }) => useChoices(client, config, () => undefined), { initialProps: { config: first } });
    expect(result.current.value("model")).toBe("opus");
    act(() => result.current.change("model", "sonnet"));
    rerender({ config: { ...first } });
    await act(async () => answer.resolve({ ok: true, data: { choice: { ...first.choice, model: "sonnet" } } }));
    expect(result.current.state("model")).toEqual({ kind: "saved" });
    expect(result.current.value("model")).toBe("sonnet");
  });
});
