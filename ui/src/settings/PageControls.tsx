import type { ConfigView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import { Lifecycle } from "../lifecycle/Lifecycle.tsx";
import { useShell } from "../shell/ShellProvider.tsx";
import { ChoiceSection } from "./ChoiceSection.tsx";
import { SettingsSkeleton } from "./SettingsSkeleton.tsx";
import { useChoices } from "./use-choices.ts";
import { usePool } from "./use-pool.ts";
import { WorkerPool } from "./WorkerPool.tsx";

/** The model and effort selects of Models, over the config the instance answers: loading, the failure, or the selects. */
export function Models() {
  const { client, connection } = useShell();
  const config = usePoll<ConfigView>(client.config, { connection, repeat: false, isEmpty: () => false });
  return (
    <Lifecycle view={config} skeleton={<SettingsSkeleton label="Loading models" />} empty={null} connection={connection?.name ?? ""}>
      {(data) => <Choices config={data} refresh={config.refresh} />}
    </Lifecycle>
  );
}

function Choices({ config, refresh }: Readonly<{ config: ConfigView; refresh: () => void }>) {
  const { client } = useShell();
  return <ChoiceSection config={config} choices={useChoices(client, config, refresh)} />;
}

/** The worker pool of Workers: the number of workers and whether they are started, over the queue the shell polls. */
export function Workers() {
  const { client, queue } = useShell();
  return <WorkerPool pool={usePool(client, queue)} />;
}

