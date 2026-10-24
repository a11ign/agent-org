import { useState } from "react";

type Copied = "idle" | "copied" | "failed";

const WORDS: Readonly<Record<Copied, string>> = { idle: "Copy", copied: "Copied", failed: "Select the text and copy it" };

/** The Copy button beside a command or a fix: it puts the text on the clipboard and says so, or, where the browser refuses, says to copy it by hand. */
export function CopyButton({ text, what = "command" }: Readonly<{ text: string; what?: "command" | "fix" }>) {
  const [copied, setCopied] = useState<Copied>("idle");
  const copy = async () => {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <button type="button" className="ghost ghost-small" aria-label={`Copy the ${what}: ${text}`} onClick={() => void copy()}>
      {WORDS[copied]}
    </button>
  );
}

/** A command or a fix in a box, with its Copy button: "Fix: <code> [Copy]". The label comes first when there is one. */
export function CommandLine({ label, text, what = "command" }: Readonly<{ label?: string; text: string; what?: "command" | "fix" }>) {
  return (
    <div className="plugin-command">
      {label === undefined ? null : <span className="plugin-command-label">{label}</span>}
      <code className="plugin-command-text">{text}</code>
      <CopyButton text={text} what={what} />
    </div>
  );
}
