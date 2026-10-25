import { Fragment } from "react";

/**
 * A backend sentence with each `quoted` word as code, as the boards draw the keys and commands in a refusal ("ticket mode: tickets.plan in the host file is not a regular expression"). The words are
 * drawn as text in a `code` element and the backticks are dropped; a sentence with an unmatched backtick is drawn as it is. Nothing is ever read as markup.
 */
export function CodeWords({ text }: Readonly<{ text: string }>) {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>))}
    </>
  );
}
