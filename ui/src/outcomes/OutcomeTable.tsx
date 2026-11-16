import type { OutcomeGroup, OutcomesView } from "../api/types.ts";
import { COLUMN_HEADINGS, COLUMNS, figureOf, sameChoice, type Choice, type Column, type Table } from "./outcomes-model.ts";

type FigureProps = Readonly<{ group: OutcomeGroup; column: Column; pricedAt: string; chosen: boolean; onChoose: () => void }>;

/** One figure: a button that lists the runs behind it below the tables, or a dash with nothing behind it. Its accessible name is the figure in full, with its group. */
function FigureCell({ group, column, pricedAt, chosen, onChoose }: FigureProps) {
  const figure = figureOf(group, column, pricedAt);
  return (
    <td className={`outcomes-figure outcomes-figure-${column}`}>
      {figure.runs.length === 0 ? (
        <span title={figure.full}>{figure.text}</span>
      ) : (
        <button type="button" className="outcomes-link" aria-pressed={chosen} aria-label={`${group.key}, ${COLUMN_HEADINGS[column]}: ${figure.full}`} title={figure.full} onClick={onChoose}>
          {figure.text}
        </button>
      )}
    </td>
  );
}

type TableProps = Readonly<{ view: OutcomesView; table: Table; choice: Choice | null; onChoose: (choice: Choice) => void }>;

/** One table of groups: a row per group, a column per figure. A table whose groups overlap says its rows are not to be added up. */
export function OutcomeTable({ view, table: { field, heading, groupHeading, overlaps }, choice, onChoose }: TableProps) {
  const id = `outcomes-${field}`;
  return (
    <section className="outcomes-section" aria-labelledby={id}>
      <h2 className="outcomes-section-title" id={id}>{heading}</h2>
      {overlaps ? <p className="outcomes-section-words">A run with more than one is counted in each, so the rows do not add up to the window.</p> : null}
      <div className="outcomes-scroll">
        <table className="outcomes-table">
          <thead>
            <tr>
              <th scope="col">{groupHeading}</th>
              {COLUMNS.map((column) => <th key={column} scope="col" className="outcomes-number">{COLUMN_HEADINGS[column]}</th>)}
            </tr>
          </thead>
          <tbody>
            {view[field].map((group) => (
              <tr key={group.key}>
                <th scope="row">{group.key}</th>
                {COLUMNS.map((column) => (
                  <FigureCell
                    key={column}
                    group={group}
                    column={column}
                    pricedAt={view.pricedAt}
                    chosen={sameChoice(choice, { table: field, key: group.key, column })}
                    onChoose={() => onChoose({ table: field, key: group.key, column })}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
