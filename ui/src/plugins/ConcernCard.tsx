import type { ReactNode } from "react";
import { SECRET_WORDS, CONTROL_LABEL } from "../../../src/ticket-mode/plugins-section.ts";
import { ConcernSettings } from "./ConcernSettings.tsx";
import { CommandLine } from "./CopyButton.tsx";
import { usePage } from "./PageContext.ts";
import { Dot } from "./StatusDot.tsx";
import { buttonsOf, checkRowsOf, concernRows, hasChoice, lockReasons, pickOf, purposeOf, shownPlugin, statusOf, titleOf, type CheckRow, type Concern, type Plugin } from "./plugins-model.ts";

/** Fixed copy under the boards' Reviewer and Code host cards: what the concern does, since neither has a setting of its own to draw. */
const NOTES: Readonly<Partial<Record<Concern["concern"], ReactNode>>> = {
  reviewer: "Starts the gate's codex reviewer once for each ready pull request head. It has no settings of its own. If reviews are required and this is off, no reviewer starts and the check above fails.",
  codeHost: (
    <>Pull requests, reviews and checks all go through GitHub, as the identity the host file names. Every other part of agent-org asks this plugin; none calls <code>gh</code> itself.</>
  ),
};

const PUBLISHER_WARNING = "This is the publish run's instruction. A wrong one lets it act outside this machine, or in your accounts.";

function Chevron() {
  return (
    <svg className="plugin-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4.5 2.5L8 6l-3.5 3.5" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One check of a plugin: what was checked, what it found in words, and the fix to run with a Copy button each. */
function Check({ row }: Readonly<{ row: CheckRow }>) {
  return (
    <div className="plugin-check">
      <span className="plugin-check-dot"><Dot tone={row.tone} /></span>
      <div className="plugin-check-text">
        <div className="plugin-check-name">{row.name}</div>
        <div className={`tone-text-${row.tone}`}>{row.detail}</div>
        {row.fixes.map((fix) => (
          <div key={fix} className="plugin-check-fix"><CommandLine label="Fix:" text={fix} what="fix" /></div>
        ))}
      </div>
    </div>
  );
}

/** The commands that set a plugin's secrets, and that install it where it is not: a secret is only ever a command, never a field. */
function Secrets({ plugin }: Readonly<{ plugin: Plugin }>) {
  if (plugin.secrets.length === 0) return null;
  return (
    <div className="plugin-panel">
      <p className="plugin-panel-words">{SECRET_WORDS}</p>
      {plugin.installed ? null : <CommandLine label="Install:" text={plugin.installCommand} />}
      {plugin.secrets.map((secret) => <CommandLine key={secret.setting} label={`Set ${secret.setting}:`} text={secret.command} />)}
    </div>
  );
}

/** The "Active plugin" choice of a concern with more than one plugin. Picking another acts at once, after the backend's confirmation where it asks for one. */
function ActivePlugin({ concern }: Readonly<{ concern: Concern }>) {
  const { answer, controls, changes } = usePage();
  const switched = changes.switched?.concern === concern.concern ? changes.switched : null;
  return (
    <div className="plugin-choice">
      <fieldset className="plugin-choices">
        <legend className="plugin-choices-legend">Active plugin</legend>
        {concern.plugins.map((plugin) => {
          const pick = pickOf(plugin);
          const blocked = !controls || changes.busy || (pick !== null && (pick.action === null || pick.reason !== null));
          return (
            <label key={plugin.name} className={`plugin-choice-option${plugin.enabled ? " plugin-choice-option-on" : ""}`}>
              <input type="radio" name={`active-${concern.concern}`} checked={plugin.enabled} disabled={pick !== null && blocked} readOnly={pick === null}
                onChange={() => pick?.action != null && changes.act(pick.action, plugin, concern, answer)} />
              <span>
                <span className="plugin-choice-name">{plugin.name}</span>
                <span className="plugin-choice-words">{plugin.description}</span>
                {pick === null || pick.reason === null ? null : <span className="plugin-choice-reason">{pick.action === null ? `Install with ${pick.reason}.` : pick.reason}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      {switched === null ? null : (
        <div className="plugin-switched">Switching runs <code>agent-org plugin enable {switched.name}</code> and needs a restart.</div>
      )}
    </div>
  );
}

/** The buttons of the plugin a card acts on, each off with the plan's reason beside it when the plan refuses it. */
function Actions({ concern, plugin }: Readonly<{ concern: Concern; plugin: Plugin }>) {
  const { answer, controls, changes } = usePage();
  const buttons = buttonsOf(plugin);
  const reasons = lockReasons(plugin);
  const keepsSettings = plugin.controls.offered.includes("disable") && plugin.controls.refused.disable === undefined;
  if (!controls || (buttons.length === 0 && reasons.length === 0)) return null;
  return (
    <div className="plugin-actions">
      {buttons.map((name) => (
        <button key={name} type="button" className="ghost" aria-label={`${CONTROL_LABEL[name]} ${plugin.name}`} disabled={changes.busy || plugin.controls.refused[name] !== undefined}
          onClick={() => changes.act(name, plugin, concern, answer)}>
          {CONTROL_LABEL[name]}
        </button>
      ))}
      {reasons.map((reason) => <span key={reason} className="plugin-lock">{reason}</span>)}
      {keepsSettings ? <span className="plugin-lock">Disabled plugins keep their settings, for <code>agent-org plugin enable {plugin.name}</code>.</span> : null}
    </div>
  );
}

function Head({ concern, open, onToggle }: Readonly<{ concern: Concern; open: boolean; onToggle: () => void }>) {
  const { instance } = usePage();
  const shown = shownPlugin(concern);
  const status = statusOf(concern, instance);
  return (
    <button type="button" className="plugin-head" aria-expanded={open} onClick={onToggle}>
      <Chevron />
      <span className="plugin-name">{titleOf(concern)}</span>
      <span className="plugin-purpose">{purposeOf(concern)}</span>
      <span className="plugin-which">
        <span className="plugin-which-name">{shown?.name ?? "None"}</span>
        {shown === null ? null : <span className="plugin-chip">v{shown.contract}</span>}
      </span>
      <span className={`plugin-status tone-text-${status.tone}`}><Dot tone={status.tone} />{status.text}</span>
    </button>
  );
}

function Body({ concern }: Readonly<{ concern: Concern }>) {
  const { instance, view } = usePage();
  // A concern of one plugin acts on it whatever its state; a concern with a choice acts on the plugin that is chosen, and the choice picks another.
  const target = shownPlugin(concern) ?? (concern.plugins.length === 1 ? concern.plugins[0] : null);
  const groups = concernRows(view, concern);
  return (
    <div className="plugin-body">
      {checkRowsOf(concern, instance).map((row) => <Check key={`${row.name}|${row.detail}`} row={row} />)}
      {target === null ? null : <Secrets plugin={target} />}
      {hasChoice(concern) ? <ActivePlugin concern={concern} /> : null}
      {concern.concern === "publisher" && groups.length > 0 ? <p className="plugin-warning">{PUBLISHER_WARNING}</p> : null}
      <ConcernSettings groups={groups} />
      {NOTES[concern.concern] === undefined ? null : <p className="plugin-note">{NOTES[concern.concern]}</p>}
      {target === null ? null : <Actions concern={concern} plugin={target} />}
    </div>
  );
}

/** One concern as a card: its name, purpose, plugin and status in the header, and, open, its checks, secrets, choice of plugin, settings and controls. */
export function ConcernCard({ concern, open, onToggle }: Readonly<{ concern: Concern; open: boolean; onToggle: () => void }>) {
  return (
    <section className="plugin-card" aria-label={titleOf(concern)}>
      <Head concern={concern} open={open} onToggle={onToggle} />
      {open ? <Body concern={concern} /> : null}
    </section>
  );
}

/** A package the registry refused: a red row with doctor's reason and fix, since it names no concern. */
export function RefusedPackage({ plugin, failure }: Readonly<{ plugin: string; failure: Readonly<{ why: string; fix: string }> }>) {
  return (
    <section className="plugin-card" aria-label={plugin}>
      <div className="plugin-head plugin-head-static">
        <span className="plugin-name">{plugin}</span>
        <span className="plugin-purpose">Refused by the registry</span>
        <span className="plugin-status tone-text-danger"><Dot tone="danger" />Failed</span>
      </div>
      <div className="plugin-body">
        <Check row={{ name: plugin, detail: failure.why, tone: "danger", fixes: [failure.fix] }} />
      </div>
    </section>
  );
}
