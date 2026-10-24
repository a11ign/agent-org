import { useState } from "react";
import type { Answer } from "../api/answer.ts";
import type { Client } from "../api/client.ts";
import type { Change, EditFile, PluginActionDone, PluginsAnswer, SettingsPreview } from "../api/types.ts";
import { dangerousIn, inForceOfSaved, isConflict, nameOf } from "../settings/settings-model.ts";
import { switchHeading, uninstallHeading, type Concern, type Plugin } from "./plugins-model.ts";

/** What the last change came to, which the page says in a banner above its tabs until the next one. `applied` carries the words the backend gave and the file it kept. */
export type Notice =
  | Readonly<{ kind: "applied"; said: string; inForce: readonly string[]; backup: string | null; file: EditFile }>
  | Readonly<{ kind: "refused"; sentence: string }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "failed"; sentence: string }>;

/** A change waiting for the person's yes: the dialog's heading, the backend's sentence, the file it would change, and what the yes does. */
export type Pending = Readonly<{ heading: string; sentence: string; confirm: string; file: EditFile; go: () => Promise<Notice | null> }>;

/** What a refused answer comes to: the file changed since the page looked, a refusal with the server's sentence, or, when no answer came at all, only what the browser said, since nothing was refused. */
function failure(answer: Extract<Answer<unknown>, { ok: false }>): Notice {
  if (answer.status === 0) return { kind: "failed", sentence: answer.refusal };
  return isConflict(answer.refusal) ? { kind: "conflict" } : { kind: "refused", sentence: answer.refusal };
}

function noticeOf(answer: Answer<PluginActionDone>, file: EditFile): Notice {
  if (!answer.ok) return failure(answer);
  const { said, inForce, backup } = answer.data;
  return { kind: "applied", said, inForce, backup: backup === null ? null : nameOf(backup), file };
}

export type Changes = Readonly<{
  notice: Notice | null;
  /** The plugin the last switch made active, with the concern it is for: the card says what that switch ran and that it needs a restart. */
  switched: Readonly<{ concern: Concern["concern"]; name: string }> | null;
  pending: Pending | null;
  busy: boolean;
  /** Does what the plugin's plan says, asking first where the backend's controls name a sentence to confirm. */
  act: (action: PluginAction, plugin: Plugin, concern: Concern, answer: PluginsAnswer) => void;
  /** Previews a change to the host file, asks first when it names a dangerous key, and saves it. */
  change: (changes: readonly Change[], said: string) => void;
  confirm: () => void;
  cancel: () => void;
  clear: () => void;
}>;

export type PluginAction = "install" | "enable" | "disable" | "uninstall";

/** What a request adds when the person has said yes to the backend's sentence, and what it adds when no sentence was asked. */
type Confirmation = Readonly<{ confirmed?: true }>;
const CONFIRMED: Confirmation = { confirmed: true };
const NOT_CONFIRMED: Confirmation = {};

/** Whether an action makes another plugin of a concern with a choice the active one: an install (which replaces) or an enable. */
const switchesPlugin = (action: PluginAction, concern: Concern): boolean => (action === "install" || action === "enable") && concern.plugins.length > 1;

type Inputs = Readonly<{ client: Client; read: () => void }>;

/**
 * The page's changes, over the backend as it is: an agent-org plugin's action (`POST /api/plugins/action`, the plans of `agent-org plugin`) and a key of the host file (`/api/settings/preview` and
 * `/save`, for the Claude plugins). Both end in the same banner, and both read the plugins again, which also updates the badge. A confirmation is the backend's sentence in a dialog; Cancel sends nothing.
 */
export function useChanges({ client, read }: Inputs): Changes {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [switched, setSwitched] = useState<Changes["switched"]>(null);
  const [busy, setBusy] = useState(false);

  /** Does a change, says how it came out, and reads the plugins again. A change that is waiting for a yes has come to nothing yet, so it reads nothing. */
  async function run(go: () => Promise<Notice | null>) {
    setBusy(true);
    setNotice(null);
    setSwitched(null);
    const done = await go();
    setBusy(false);
    setNotice(done);
    if (done !== null) read();
  }

  const request = (action: PluginAction, plugin: Plugin, concern: Concern, answer: PluginsAnswer, confirmation: Confirmation) => async (): Promise<Notice> => {
    const done = noticeOf(await client.pluginAction({ action, name: plugin.name, base: answer.bases[concern.file] ?? "", ...confirmation }), concern.file);
    if (done.kind === "applied" && switchesPlugin(action, concern)) setSwitched({ concern: concern.concern, name: plugin.name });
    return done;
  };

  function act(action: PluginAction, plugin: Plugin, concern: Concern, answer: PluginsAnswer) {
    const sentence = action === "install" || action === "uninstall" ? plugin.controls.confirm[action] : undefined;
    if (sentence === undefined) {
      void run(request(action, plugin, concern, answer, NOT_CONFIRMED));
      return;
    }
    setNotice(null);
    const heading = action === "uninstall" ? uninstallHeading(plugin) : switchHeading(concern);
    setPending({ heading, sentence, confirm: action === "uninstall" ? "Uninstall" : "Switch", file: concern.file, go: request(action, plugin, concern, answer, CONFIRMED) });
  }

  /** Saves a previewed change with the dangerous keys the person confirmed, which the preview names. */
  async function save(file: EditFile, changes: readonly Change[], said: string, preview: SettingsPreview): Promise<Notice> {
    const saved = await client.saveSettings({ file, changes, base: preview.base, confirmed: dangerousIn(preview) });
    if (!saved.ok) return failure(saved);
    return { kind: "applied", said, inForce: inForceOfSaved(saved.data), backup: nameOf(saved.data.backup), file };
  }

  function change(changes: readonly Change[], said: string) {
    const file: EditFile = "host.json";
    void run(async () => {
      const preview = await client.previewSettings(file, changes);
      if (!preview.ok) return failure(preview);
      const dangerous = preview.data.changes.filter((entry) => entry.dangerous !== null && entry.changed);
      if (dangerous.length === 0) return save(file, changes, said, preview.data);
      const sentence = dangerous.map((entry) => entry.dangerous).join(" ");
      setPending({ heading: `Change ${dangerous.map((entry) => entry.key).join(", ")}?`, sentence, confirm: "Change", file, go: () => save(file, changes, said, preview.data) });
      return null;
    });
  }

  return {
    notice, switched, pending, busy, act, change, clear: () => setNotice(null),
    confirm: () => {
      if (pending === null) return;
      setPending(null);
      void run(pending.go);
    },
    cancel: () => setPending(null),
  };
}
